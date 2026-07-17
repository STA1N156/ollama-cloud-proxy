import { buildFingerprint, cachedTokenCount } from './cache.js';

const retryable = new Set([401, 403, 408, 429, 500, 502, 503, 504]);
const hopByHop = new Set(['authorization', 'connection', 'content-length', 'content-encoding', 'cookie', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

const jsonError = (res, status, message, type = 'proxy_error') => {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: { message, type, code: status } });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const bearer = (header = '') => header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';

async function readBody(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function includeUsage(request) {
  return request.stream_options?.include_usage === true;
}

function forceUsage(request, pathname) {
  if (!request.stream || !['/v1/chat/completions', '/v1/completions'].includes(pathname)) return request;
  return { ...request, stream_options: { ...(request.stream_options || {}), include_usage: true } };
}

function usageFromObject(object, hit, totalWeight, injectCache = true) {
  const usage = object?.usage || object?.response?.usage;
  if (!usage || typeof usage !== 'object') return null;

  const chat = usage.prompt_tokens != null;
  const promptTokens = Number(chat ? usage.prompt_tokens : usage.input_tokens) || 0;
  const completionTokens = Number(chat ? usage.completion_tokens : usage.output_tokens) || 0;
  const totalTokens = Number(usage.total_tokens) || promptTokens + completionTokens;
  const detailKey = chat ? 'prompt_tokens_details' : 'input_tokens_details';
  const details = usage[detailKey] && typeof usage[detailKey] === 'object' ? usage[detailKey] : {};
  const upstreamCached = Number(details.cached_tokens) || 0;
  const proxyCached = injectCache ? cachedTokenCount(hit, promptTokens, totalWeight) : 0;
  const cachedTokens = Math.min(promptTokens, Math.max(proxyCached, upstreamCached));
  if (injectCache) usage[detailKey] = { ...details, cached_tokens: cachedTokens };
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

export function injectUsage(data, hit, totalWeight, injectCache = true) {
  let object;
  try {
    object = JSON.parse(data);
  } catch {
    return { data, usage: null, usageOnly: false };
  }
  const usage = usageFromObject(object, hit, totalWeight, injectCache);
  const usageOnly = Boolean(usage && Array.isArray(object.choices) && object.choices.length === 0);
  return { data: JSON.stringify(object), usage, usageOnly };
}

function patchSseEvent(event, hit, totalWeight, forwardUsage, injectCache) {
  const lines = event.replace(/\r\n/g, '\n').split('\n');
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (!dataLines.length) return { event, usage: null, done: false };
  const data = dataLines.map((line) => line.slice(5).trimStart()).join('\n');
  if (data === '[DONE]') return { event, usage: null, done: true };
  const patched = injectUsage(data, hit, totalWeight, injectCache);
  let object;
  try { object = JSON.parse(patched.data); } catch { object = null; }
  const done = object?.type === 'response.completed' || object?.response?.status === 'completed';
  if (!patched.usage) return { event, usage: null, done };
  if (patched.usageOnly && !forwardUsage) return { event: '', usage: patched.usage, done };
  const rebuilt = lines.filter((line) => !line.startsWith('data:'));
  const insertAt = rebuilt.findIndex((line) => line === '');
  rebuilt.splice(insertAt < 0 ? rebuilt.length : insertAt, 0, `data: ${patched.data}`);
  return { event: rebuilt.join('\n'), usage: patched.usage, done };
}

function copyRequestHeaders(req, secret) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (!hopByHop.has(name.toLowerCase()) && value != null) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('authorization', `Bearer ${secret}`);
  headers.set('content-type', headers.get('content-type') || 'application/json');
  return headers;
}

function copyResponseHeaders(upstream, res, hit) {
  for (const [name, value] of upstream.headers) {
    if (!hopByHop.has(name.toLowerCase())) res.setHeader(name, value);
  }
  res.setHeader('x-proxy-cache', hit.matched ? 'HIT' : 'MISS');
  if (hit.matched) res.setHeader('x-proxy-cache-type', hit.exact ? 'exact' : 'prefix');
  res.setHeader('x-proxy-cache-source', 'proxy-simulated');
  res.setHeader('access-control-allow-origin', '*');
}

async function writeChunk(res, chunk, signal) {
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      signal?.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('客户端已断开')); };
    const onAbort = () => { cleanup(); reject(signal.reason || new Error('请求已取消')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const retryAfterMs = (response) => {
  const raw = response.headers.get('retry-after');
  if (!raw) return 30_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 30_000;
};

export class ProxyHandler {
  constructor(config, store, pool, ledger) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.ledger = ledger;
  }

  authenticate(req) {
    const token = bearer(req.headers.authorization);
    if (token) {
      const id = this.store.validateClientKey(token);
      if (id) return id;
      throw Object.assign(new Error('下游访问密钥无效'), { status: 401 });
    }
    if (this.config.allowAnonymous) return null;
    if (!this.store.clientKeyCount()) throw Object.assign(new Error('尚未配置下游访问密钥，请先登录 /admin 创建'), { status: 503 });
    throw Object.assign(new Error('缺少下游访问密钥'), { status: 401 });
  }

  models(res, name = '') {
    const models = this.store.listModels();
    const convert = (item) => ({
      id: item.model || item.name,
      object: 'model',
      created: Math.floor((Date.parse(item.modified_at) || item.synced_at) / 1000),
      owned_by: 'ollama',
    });
    const selected = name ? models.find((item) => item.model === name || item.name === name) : null;
    if (name && !selected) return jsonError(res, 404, `模型不存在：${name}`, 'invalid_request_error');
    const body = JSON.stringify(selected ? convert(selected) : { object: 'list', data: models.map(convert) });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'access-control-allow-origin': '*' });
    res.end(body);
  }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://proxy.local');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }
    let clientKeyId;
    try {
      clientKeyId = this.authenticate(req);
    } catch (error) {
      return jsonError(res, error.status || 401, error.message, 'authentication_error');
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') return this.models(res);
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) return this.models(res, decodeURIComponent(url.pathname.slice(11)));
    if (req.method !== 'POST' || !url.pathname.startsWith('/v1/')) return jsonError(res, 404, '接口不存在', 'invalid_request_error');

    let raw;
    let request;
    try {
      raw = await readBody(req, this.config.maxRequestBytes);
      request = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      return jsonError(res, error.status || 400, error.status ? error.message : 'JSON 请求体无效', 'invalid_request_error');
    }

    const model = typeof request.model === 'string' ? request.model : '';
    if (!model) return jsonError(res, 400, 'model 不能为空', 'invalid_request_error');
    const stream = request.stream === true;
    const clientWantsUsage = includeUsage(request);
    const forceStreamUsage = stream && ['/v1/chat/completions', '/v1/completions'].includes(url.pathname) && !clientWantsUsage;
    const upstreamBody = forceStreamUsage ? Buffer.from(JSON.stringify(forceUsage(request, url.pathname))) : raw;
    const cacheable = ['/v1/chat/completions', '/v1/responses', '/v1/completions'].includes(url.pathname);
    const fingerprint = buildFingerprint(url.pathname, request, this.store.masterKey);
    const hit = cacheable ? this.ledger.lookup(fingerprint, model) : { matched: false, exact: false, weight: 0, observedTokens: 0 };
    const excluded = new Set();
    const controller = new AbortController();
    req.once('aborted', () => controller.abort(new Error('客户端已断开')));
    res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('客户端已断开')); });

    let lease;
    let upstream;
    let lastError;
    for (let attempt = 0; attempt < this.config.retryCount; attempt += 1) {
      try {
        lease = await this.pool.acquire(model, excluded, controller.signal);
        excluded.add(lease.id);
        const target = `${this.config.upstreamBaseUrl}${url.pathname.slice(3)}${url.search}`;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.responseHeaderTimeoutMs)]);
        upstream = await fetch(target, {
          method: 'POST',
          headers: copyRequestHeaders(req, lease.secret),
          body: upstreamBody,
          signal,
          redirect: 'manual',
        });
        if (!retryable.has(upstream.status)) break;
        const errorText = (await upstream.text()).slice(0, 500);
        const invalid = upstream.status === 401 || upstream.status === 403;
        const cooldown = upstream.status === 429 ? retryAfterMs(upstream) : 3000;
        this.pool.report(lease.id, invalid ? 'invalid' : upstream.status === 429 ? 'cooldown' : 'degraded', `HTTP ${upstream.status}: ${errorText}`, invalid ? 0 : cooldown);
        lastError = new Error(`Ollama Cloud 返回 HTTP ${upstream.status}`);
        lease.release();
        lease = null;
        upstream = null;
      } catch (error) {
        lastError = error;
        if (lease) {
          this.pool.report(lease.id, 'degraded', error.message, 3000);
          lease.release();
          lease = null;
        }
        if (controller.signal.aborted) break;
      }
    }

    if (!upstream || !lease) {
      this.store.queueUsage({ clientKeyId, model, endpoint: url.pathname, status: 502, latencyMs: Date.now() - started, stream, error: lastError?.message });
      return jsonError(res, 502, lastError?.message || 'Ollama Cloud 暂时不可用');
    }

    if (upstream.status === 401 || upstream.status === 403) this.pool.report(lease.id, 'invalid', `HTTP ${upstream.status}`);
    else if (upstream.status < 500) this.pool.report(lease.id, 'healthy');

    copyResponseHeaders(upstream, res, hit);
    let usage = null;
    let completed = false;
    try {
      if (stream && upstream.ok && upstream.body) {
        res.statusCode = upstream.status;
        res.flushHeaders();
        const streamed = await this.pipeStream(upstream, res, hit, fingerprint.totalWeight, clientWantsUsage, cacheable, controller.signal);
        usage = streamed.usage;
        completed = streamed.complete;
        if (!completed) lastError = new Error('上游流式响应未正常结束');
        res.end();
      } else {
        const input = await upstream.text();
        const patched = upstream.ok ? injectUsage(input, hit, fingerprint.totalWeight, cacheable) : { data: input, usage: null };
        usage = patched.usage;
        completed = true;
        const body = Buffer.from(patched.data);
        res.statusCode = upstream.status;
        res.setHeader('content-length', body.length);
        res.end(body);
      }
    } catch (error) {
      lastError = error;
      if (!res.writableEnded) res.destroy(error);
    } finally {
      lease.release();
      if (cacheable && completed && upstream.ok) this.ledger.register(fingerprint, model, usage?.promptTokens || 0);
      this.store.queueUsage({
        upstreamKeyId: lease.id,
        clientKeyId,
        model,
        endpoint: url.pathname,
        promptTokens: usage?.promptTokens || 0,
        completionTokens: usage?.completionTokens || 0,
        cachedTokens: usage?.cachedTokens || 0,
        totalTokens: usage?.totalTokens || 0,
        status: upstream.status,
        latencyMs: Date.now() - started,
        stream,
        error: lastError?.message || '',
      });
    }
  }

  async pipeStream(upstream, res, hit, totalWeight, forwardUsage, injectCache, signal) {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let complete = false;
    while (true) {
      if (signal.aborted) throw signal.reason;
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      while (true) {
        const match = buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const end = match.index + match[0].length;
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end);
        const patched = patchSseEvent(event, hit, totalWeight, forwardUsage, injectCache);
        if (patched.usage) usage = patched.usage;
        if (patched.done) complete = true;
        if (patched.event) await writeChunk(res, patched.event, signal);
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const patched = patchSseEvent(buffer, hit, totalWeight, forwardUsage, injectCache);
      if (patched.usage) usage = patched.usage;
      if (patched.done) complete = true;
      if (patched.event) await writeChunk(res, patched.event, signal);
    }
    return { usage, complete };
  }
}
