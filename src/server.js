import http from 'node:http';
import { config } from './config.js';
import { Store } from './store.js';
import { CacheLedger } from './cache.js';
import { KeyPool } from './key-pool.js';
import { ModelSync } from './model-sync.js';
import { ProxyHandler } from './proxy.js';
import { AdminHandler } from './admin.js';

const store = new Store(config);
config.upstreamKeys.forEach((key, index) => store.addUpstreamKey(`Env Key ${index + 1}`, key));
config.clientKeys.forEach((key, index) => store.addClientKey(`Env Client ${index + 1}`, key));

const pool = new KeyPool(store, config.maxInflightPerKey);
const ledger = new CacheLedger(store, config.cacheTtlMs);
const modelSync = new ModelSync(config, store, pool);
const proxy = new ProxyHandler(config, store, pool, ledger);
const admin = new AdminHandler(config, store, pool, ledger, modelSync);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://proxy.local');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (url.pathname === '/readyz') {
      const ready = pool.snapshot().some((key) => key.enabled && key.status !== 'invalid');
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ready }));
    }
    if (url.pathname.startsWith('/admin')) return void await admin.handle(req, res);
    if (url.pathname.startsWith('/v1/')) return void await proxy.handle(req, res);
    if (url.pathname === '/') {
      const body = JSON.stringify({ name: 'Ollama Cloud Proxy', admin: '/admin', api: '/v1' });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"Not found","type":"invalid_request_error"}}');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"Internal server error","type":"proxy_error"}}');
    } else res.destroy(error);
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 0;
server.listen(config.port, config.host, () => {
  console.log(`Ollama Cloud Proxy listening on http://${config.host}:${config.port}`);
  if (config.adminPassword === '123456') console.warn('警告：ADMIN_PASSWORD 正在使用默认值 123456');
  if (!config.allowAnonymous && !store.clientKeyCount()) console.warn('请登录 /admin 创建下游访问密钥');
  modelSync.start();
});

const shutdown = () => {
  server.close(() => {
    modelSync.stop();
    ledger.close();
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
