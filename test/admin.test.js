import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { AdminHandler } from '../src/admin.js';
import { CacheLedger } from '../src/cache.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

test('缓存页面可读取、修改设置和清空，仍不提供 RP 或粘性路由', async (t) => {
  const config = tempConfig();
  const store = new Store(config);
  const ledger = new CacheLedger(store);
  const admin = new AdminHandler(config, store, null, null, null, null, null, ledger);
  const server = http.createServer((req, res) => admin.handle(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await ledger.close(); store.close(); config.cleanup(); });

  const html = await (await fetch(`${base}/admin`)).text();
  const script = await (await fetch(`${base}/admin/app.js`)).text();
  assert.match(html, /id="page-cache"/);
  assert.match(html, /id="cache-ttl"[^>]*value="10"/);
  assert.doesNotMatch(html, /rp-cache|sticky-routing/);
  assert.doesNotMatch(script, /rp-cache|sticky-routing/);
  assert.match(script, /toggle-upstream-cache/);
  assert.match(script, /官方缓存/);
  for (const [, id] of script.matchAll(/\$\('#([\w-]+)'\)/g)) {
    assert.ok(html.includes(`id="${id}"`), `页面缺少元素 ${id}`);
  }
  const headers = { cookie: `admin_session=${admin.session()}`, 'x-admin-request': '1' };
  assert.equal((await fetch(`${base}/admin/api/cache`)).status, 401);
  const initial = await (await fetch(`${base}/admin/api/cache`, { headers })).json();
  assert.equal(initial.cache.ttlMs, 600_000);
  assert.equal(initial.cache.enabled, true);
  const updated = await fetch(`${base}/admin/api/cache`, {
    method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, ttlMs: 120_000 }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).cache, { enabled: false, ttlMs: 120_000 });
  assert.equal((await fetch(`${base}/admin/api/cache`, { method: 'PATCH', headers, body: '{"ttlMs":0}' })).status, 400);
  assert.equal((await fetch(`${base}/admin/api/cache`, { method: 'PATCH', headers: { cookie: headers.cookie }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/admin/api/cache`, { method: 'DELETE', headers })).status, 200);
  for (const [path, method] of [['cache/rp', 'PATCH'], ['cache/sticky', 'PATCH']]) {
    assert.equal((await fetch(`${base}/admin/api/${path}`, { method, headers })).status, 404);
  }
});

test('Ollama 单密钥测试使用 deepseek-v4-flash:0731 发送消息', async (t) => {
  let request;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    request = { method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks)) };
    res.setHeader('content-type', 'application/json');
    res.end('{"choices":[{"message":{"role":"assistant","content":"OK"}}]}');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const config = tempConfig({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1` });
  const store = new Store(config);
  const id = store.addUpstreamKey('Ollama', 'key-a');
  const reports = [];
  let acquired;
  const pool = {
    report: (...args) => reports.push(args),
    acquire: async (model, excluded, signal, sourceUrl) => {
      acquired = { model, sourceUrl };
      return { id, baseUrl: config.upstreamBaseUrl, secret: 'key-a', release() {} };
    },
  };
  const admin = new AdminHandler(config, store, pool, null, { sync: async () => {} });
  t.after(() => { upstream.close(); store.close(); config.cleanup(); });

  assert.deepEqual(await admin.testKey(id), { ok: true });
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/chat/completions');
  assert.equal(request.body.model, 'deepseek-v4-flash:0731');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '请只回复 OK' }]);
  assert.equal(reports.at(-1)[1], 'healthy');

  assert.deepEqual(await admin.testModel('model-a', config.upstreamBaseUrl), { ok: true });
  assert.deepEqual(acquired, { model: 'model-a', sourceUrl: config.upstreamBaseUrl });
  assert.equal(request.body.model, 'model-a');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '请只回复 OK' }]);
});
