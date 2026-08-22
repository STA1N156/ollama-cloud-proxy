import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { AdminHandler } from '../src/admin.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

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
  const admin = new AdminHandler(config, store, pool, null, null, { sync: async () => {} });
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
