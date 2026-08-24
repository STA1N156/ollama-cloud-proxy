import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { once } from 'node:events';
import { KeyPool } from '../src/key-pool.js';
import { ModelSync } from '../src/model-sync.js';
import { Store } from '../src/store.js';
import { tempConfig } from '../test-support/helpers.js';

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};

test('同步期间新增外部渠道会在补跑中纳入', async (t) => {
  let releaseFirst;
  const firstRequest = new Promise((resolve) => { releaseFirst = resolve; });
  let requests = 0;
  const firstServer = http.createServer(async (req, res) => {
    if (req.url !== '/v1/models') return res.writeHead(404).end();
    requests += 1;
    if (requests === 1) await firstRequest;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'first-model' }] }));
  });
  const secondServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'second-model' }] }));
  });
  const firstOrigin = await listen(firstServer);
  const secondOrigin = await listen(secondServer);
  const config = tempConfig({
    upstreamBaseUrl: `${firstOrigin}/v1`,
    modelSyncUrl: `${firstOrigin}/v1/models`,
    retryCount: 1,
  });
  const store = new Store(config);
  const pool = new KeyPool(store, () => {});
  const modelSync = new ModelSync(config, store, pool);
  store.addUpstreamKey('first', 'first-secret', `${firstOrigin}/v1`);
  pool.reload();
  const running = modelSync.sync();
  await new Promise((resolve) => {
    const check = () => (requests ? resolve() : setTimeout(check, 0));
    check();
  });

  store.addUpstreamKey('second', 'second-secret', `${secondOrigin}/v1`);
  pool.reload();
  const queued = modelSync.sync();
  releaseFirst();
  await queued;
  assert.deepEqual(store.listModels().map((item) => item.name).sort(), ['first-model', 'second-model']);

  t.after(() => {
    modelSync.stop();
    store.close();
    firstServer.close();
    secondServer.close();
    config.cleanup();
  });
  await running;
});

test('外部渠道返回空模型列表时保留原有模型', async (t) => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"data":[]}');
  });
  const origin = await listen(server);
  const config = tempConfig({
    upstreamBaseUrl: `${origin}/v1`,
    modelSyncUrl: `${origin}/v1/models`,
    retryCount: 1,
  });
  const store = new Store(config);
  store.addUpstreamKey('external', 'external-secret', `${origin}/v1`);
  store.replaceModels(`${origin}/v1`, [{ name: 'keep-model' }]);
  const pool = new KeyPool(store, () => {});
  const modelSync = new ModelSync(config, store, pool);
  await assert.rejects(modelSync.sync(), /模型列表为空/);
  assert.deepEqual(store.listModels().map((item) => item.name), ['keep-model']);
  t.after(() => {
    modelSync.stop();
    store.close();
    server.close();
    config.cleanup();
  });
});
