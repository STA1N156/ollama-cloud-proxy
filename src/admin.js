import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hmac256, randomToken, safeEqual } from './crypto.js';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const assets = new Map([
  ['/admin', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/', ['admin.html', 'text/html; charset=utf-8']],
  ['/admin/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/admin/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

const send = (res, status, data) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
};

async function json(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}

const cookies = (header = '') => Object.fromEntries(header.split(';').map((item) => item.trim().split('=').map(decodeURIComponent)).filter((item) => item.length === 2));

export class AdminHandler {
  constructor(config, store, pool, ledger, modelSync) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.ledger = ledger;
    this.modelSync = modelSync;
    this.loginAttempts = new Map();
  }

  session() {
    const expires = Date.now() + 12 * 60 * 60_000;
    return `${expires}.${hmac256(this.store.masterKey, String(expires))}`;
  }

  authenticated(req) {
    const value = cookies(req.headers.cookie).admin_session || '';
    const [expires, signature] = value.split('.');
    return Number(expires) > Date.now() && safeEqual(signature || '', hmac256(this.store.masterKey, expires || ''));
  }

  async login(req, res) {
    const ip = req.socket.remoteAddress || 'unknown';
    const attempt = this.loginAttempts.get(ip) || { failures: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) return send(res, 429, { error: '尝试次数过多，请稍后再试' });
    const body = await json(req);
    if (!safeEqual(String(body.password || ''), this.config.adminPassword)) {
      attempt.failures += 1;
      if (attempt.failures >= 5) {
        attempt.failures = 0;
        attempt.blockedUntil = Date.now() + 60_000;
      }
      this.loginAttempts.set(ip, attempt);
      return send(res, 401, { error: '管理密钥不正确' });
    }
    this.loginAttempts.delete(ip);
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('set-cookie', `admin_session=${encodeURIComponent(this.session())}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200${secure ? '; Secure' : ''}`);
    return send(res, 200, { ok: true, defaultPassword: this.config.adminPassword === '123456' });
  }

  async testKey(id) {
    const key = this.store.getUpstreamKey(id);
    if (!key) throw Object.assign(new Error('密钥不存在'), { status: 404 });
    const response = await fetch(`${key.base_url}/models`, {
      headers: { authorization: `Bearer ${key.secret}`, accept: 'application/json' },
      signal: AbortSignal.timeout(Math.min(this.config.responseHeaderTimeoutMs, 30_000)),
    });
    if (!response.ok) {
      this.pool.report(id, response.status === 401 || response.status === 403 ? 'invalid' : 'degraded', `HTTP ${response.status}`);
      throw Object.assign(new Error(`测试失败：HTTP ${response.status}`), { status: 400 });
    }
    await response.body?.cancel();
    this.pool.report(id, 'healthy');
    this.modelSync.sync().catch(() => {});
    return { ok: true };
  }

  async api(req, res, url) {
    if (url.pathname === '/admin/api/login' && req.method === 'POST') return this.login(req, res);
    if (!this.authenticated(req)) return send(res, 401, { error: '请先登录' });
    if (req.method !== 'GET' && req.headers['x-admin-request'] !== '1') return send(res, 403, { error: '请求校验失败' });

    if (url.pathname === '/admin/api/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', 'admin_session=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/admin/api/summary' && req.method === 'GET') {
      const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
      return send(res, 200, {
        ...this.store.summary(hours),
        upstreamKeys: this.pool.snapshot(),
        clientKeys: this.store.listClientKeys(),
        models: this.store.listModels(),
        cache: await this.ledger.stats(),
        modelSyncError: this.modelSync.lastError,
        defaultPassword: this.config.adminPassword === '123456',
        allowAnonymous: this.config.allowAnonymous,
      });
    }
    if (url.pathname === '/admin/api/upstream-keys' && req.method === 'POST') {
      const body = await json(req);
      const id = this.store.addUpstreamKey(String(body.label || ''), String(body.key || ''), String(body.baseUrl || ''), Boolean(body.useProxyCache));
      this.pool.reload();
      this.modelSync.sync().catch(() => {});
      return send(res, 201, { id });
    }
    const upstream = url.pathname.match(/^\/admin\/api\/upstream-keys\/(\d+)(?:\/(test))?$/);
    if (upstream) {
      const id = Number(upstream[1]);
      if (upstream[2] === 'test' && req.method === 'POST') return send(res, 200, await this.testKey(id));
      if (req.method === 'PATCH') {
        const body = await json(req);
        if (body.enabled != null) this.store.setUpstreamEnabled(id, Boolean(body.enabled));
        if (body.useProxyCache != null) this.store.setUpstreamProxyCache(id, Boolean(body.useProxyCache));
        this.pool.reload();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        this.store.deleteUpstreamKey(id);
        this.pool.reload();
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/admin/api/client-keys' && req.method === 'POST') {
      const body = await json(req);
      const token = randomToken('ocp_');
      const id = this.store.addClientKey(String(body.label || ''), token, body.outputTps, body.allowedOrigin);
      return send(res, 201, { id, token });
    }
    const client = url.pathname.match(/^\/admin\/api\/client-keys\/(\d+)(?:\/(reveal))?$/);
    if (client) {
      const id = Number(client[1]);
      if (client[2] === 'reveal' && req.method === 'POST') {
        return send(res, 200, { token: this.store.getClientKeyToken(id) });
      }
      if (req.method === 'PATCH') {
        const body = await json(req);
        if (body.enabled != null) this.store.setClientEnabled(id, Boolean(body.enabled));
        if (body.outputTps != null) this.store.setClientOutputTps(id, body.outputTps);
        if (body.allowedOrigin != null) this.store.setClientAllowedOrigin(id, body.allowedOrigin);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'DELETE') {
        this.store.deleteClientKey(id);
        return send(res, 200, { ok: true });
      }
    }
    if (url.pathname === '/admin/api/models/sync' && req.method === 'POST') {
      return send(res, 200, { ok: true, count: await this.modelSync.sync() });
    }
    if (url.pathname === '/admin/api/cache' && req.method === 'DELETE') {
      await this.ledger.clear();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/admin/api/cache/rp' && req.method === 'PATCH') {
      const body = await json(req);
      return send(res, 200, await this.ledger.setRpEnabled(Boolean(body.enabled)));
    }
    if (url.pathname === '/admin/api/usage' && req.method === 'DELETE') {
      this.store.clearUsage();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: '接口不存在' });
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://admin.local');
    try {
      if (url.pathname.startsWith('/admin/api/')) return await this.api(req, res, url);
      const asset = assets.get(url.pathname);
      if (!asset) return false;
      const body = fs.readFileSync(path.join(publicDir, asset[0]));
      res.writeHead(200, {
        'content-type': asset[1],
        'content-length': body.length,
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
      });
      res.end(body);
      return true;
    } catch (error) {
      send(res, error.status || 500, { error: error.message || '服务器错误' });
      return true;
    }
  }
}
