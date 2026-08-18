import { cachedTokenCount } from './cache.js';

const retryable = new Set([401, 403, 408, 429, 500, 502, 503, 504]);
const hopByHop = new Set(['authorization', 'connection', 'content-length', 'content-encoding', 'cookie', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const rphOrigins = new Set(['https://sta1n156.github.io', 'https://api.sta1n.site', 'https://cdn.sta1n.cn']);
const codexRouterAgent = /^codex-router\/\S+/i;
const internalServerError400 = (status, body) => status === 400 && /\binternal server error\b/i.test(body);

const jsonError = (res, status, message, type = 'proxy_error') => {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: { message, type, code: status } });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const bearer = (header = '') => header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  if (signal?.aborted) return reject(signal.reason || new Error('请求已取消'));
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); reject(signal.reason || new Error('请求已取消')); }
  signal?.addEventListener('abort', abort, { once: true });
});

function normalizeReasoning(object) {
  let normalized = false;
  for (const choice of object?.choices || []) {
    for (const part of [choice.message, choice.delta]) {
      const reasoning = part?.reasoning ?? part?.thinking;
      if (typeof reasoning === 'string' && part.reasoning_content == null) {
        part.reasoning_content = reasoning;
        normalized = true;
      }
    }
  }
  return normalized;
}

function outputCharacterCount(object) {
  const parts = [];
  const add = (value) => {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) value.forEach((item) => add(item?.text ?? item?.content));
  };
  for (const choice of object?.choices || []) {
    add(choice.text);
    add(choice.delta?.content);
    add(choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.delta?.thinking);
    for (const call of choice.delta?.tool_calls || []) add(call.function?.arguments);
  }
  add(object?.delta);
  add(object?.output_text);
  const text = parts.join('');
  return [...text].length;
}

class TokenPacer {
  constructor(rate, signal) {
    this.rate = rate;
    this.signal = signal;
    this.nextAt = Date.now();
  }

  async pace(characters) {
    const now = Date.now();
    const delay = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(this.nextAt, now) + Math.max(0, characters) * 1000 / this.rate;
    await wait(delay, this.signal);
  }
}

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

function forceUsageBody(raw, request, pathname) {
  if (!request.stream || !['/v1/chat/completions', '/v1/completions'].includes(pathname)) return raw;
  if (request.stream_options == null) {
    let end = raw.length - 1;
    while (end >= 0 && /\s/.test(String.fromCharCode(raw[end]))) end -= 1;
    if (raw[end] === 0x7d) {
      const field = Buffer.from(',"stream_options":{"include_usage":true}');
      return Buffer.concat([raw.subarray(0, end), field, raw.subarray(end)]);
    }
  }
  return Buffer.from(JSON.stringify(forceUsage(request, pathname)));
}

function cacheRequest(request) {
  const selected = {};
  for (const field of ['messages', 'input', 'prompt', 'instructions', 'tools', 'response_format']) {
    if (request[field] != null) selected[field] = request[field];
  }
  if (request.text?.format != null) selected.text = { format: request.text.format };
  return selected;
}

function usageFromObject(object, hit, totalWeight, injectCache = true, replaceUpstreamCache = false) {
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
  const cachedTokens = Math.min(promptTokens, replaceUpstreamCache ? proxyCached : Math.max(proxyCached, upstreamCached));
  if (injectCache) usage[detailKey] = { ...details, cached_tokens: cachedTokens };
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

function mergeUsage(current, next) {
  if (!next) return current;
  if (!current) return next;
  const promptTokens = Math.max(current.promptTokens, next.promptTokens);
  const completionTokens = Math.max(current.completionTokens, next.completionTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(current.totalTokens, next.totalTokens, promptTokens + completionTokens),
    cachedTokens: Math.max(current.cachedTokens, next.cachedTokens),
  };
}

export function injectUsage(data, hit, totalWeight, injectCache = true, replaceUpstreamCache = false) {
  let object;
  try {
    object = JSON.parse(data);
  } catch {
    return { data, usage: null, usageOnly: false, reasoningNormalized: false };
  }
  const reasoningNormalized = normalizeReasoning(object);
  const usage = usageFromObject(object, hit, totalWeight, injectCache, replaceUpstreamCache);
  const usageOnly = Boolean(usage && Array.isArray(object.choices) && object.choices.length === 0);
  return { data: JSON.stringify(object), usage, usageOnly, reasoningNormalized };
}

async function patchSseEvent(event, resolveCache, forwardUsage, injectCache, countOutput = false, replaceUpstreamCache = false) {
  const lines = event.replace(/\r\n/g, '\n').split('\n');
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (!dataLines.length) return { event, usage: null, usageOnly: false, done: false, outputCharacters: 0 };
  const data = dataLines.map((line) => line.slice(5).trimStart()).join('\n');
  if (data === '[DONE]') return { event, usage: null, usageOnly: false, done: true, outputCharacters: 0 };
  let object;
  try { object = JSON.parse(data); } catch { object = null; }
  if (!object) return { event, usage: null, usageOnly: false, done: false, outputCharacters: 0 };
  const reasoningNormalized = normalizeReasoning(object);
  const rawUsage = object?.usage || object?.response?.usage;
  const cache = rawUsage && typeof rawUsage === 'object' && injectCache
    ? await resolveCache()
    : { hit: null, fingerprint: { totalWeight: 0 } };
  const usage = usageFromObject(object, cache.hit, cache.fingerprint.totalWeight, injectCache, replaceUpstreamCache);
  const usageOnly = Boolean(usage && Array.isArray(object.choices) && object.choices.length === 0);
  const done = object?.type === 'response.completed' || object?.response?.status === 'completed';
  const outputCharacters = countOutput ? outputCharacterCount(object) : 0;
  if (usageOnly && !forwardUsage) return { event: '', usage, usageOnly: true, done, outputCharacters };
  if (!reasoningNormalized && !(usage && injectCache)) return { event, usage, usageOnly, done, outputCharacters };
  const rebuilt = lines.filter((line) => !line.startsWith('data:'));
  const insertAt = rebuilt.findIndex((line) => line === '');
  rebuilt.splice(insertAt < 0 ? rebuilt.length : insertAt, 0, `data: ${JSON.stringify(object)}`);
  return { event: rebuilt.join('\n'), usage, usageOnly, done, outputCharacters };
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

function copyResponseHeaders(upstream, res, hit, localCache) {
  for (const [name, value] of upstream.headers) {
    if (!hopByHop.has(name.toLowerCase()) && !name.toLowerCase().startsWith('access-control-')) res.setHeader(name, value);
  }
  res.setHeader('x-proxy-cache', localCache ? (hit ? (hit.matched ? 'HIT' : 'MISS') : 'PENDING') : 'BYPASS');
  if (localCache && hit?.matched) res.setHeader('x-proxy-cache-type', hit.type || (hit.exact ? 'exact' : 'prefix'));
  res.setHeader('x-proxy-cache-source', localCache ? 'proxy-simulated' : 'upstream');
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
  constructor(config, store, pool, ledger, usage) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.ledger = ledger;
    this.usage = usage;
  }

  authenticate(req) {
    const token = bearer(req.headers.authorization);
    if (token) {
      const access = this.store.getClientAccess(token);
      if (access) return access;
      throw Object.assign(new Error('下游访问密钥无效'), { status: 401 });
    }
    if (this.config.allowAnonymous) return { id: null, outputTps: 0, allowedOrigin: '' };
    if (!this.store.clientKeyCount()) throw Object.assign(new Error('尚未配置下游访问密钥，请先登录 /admin 创建'), { status: 503 });
    throw Object.assign(new Error('缺少下游访问密钥'), { status: 401 });
  }

  models(res, name = '') {
    const models = [...new Map(this.store.listModels().filter((item) => item.key_count > 0).map((item) => [item.model || item.name, item])).values()];
    const convert = (item) => ({
      id: item.model || item.name,
      object: 'model',
      created: Math.floor((Date.parse(item.modified_at) || item.synced_at) / 1000),
      owned_by: item.source_label || 'upstream',
    });
    const selected = name ? models.find((item) => item.model === name || item.name === name) : null;
    if (name && !selected) return jsonError(res, 404, `模型不存在：${name}`, 'invalid_request_error');
    const body = JSON.stringify(selected ? convert(selected) : { object: 'list', data: models.map(convert) });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://proxy.local');
    if (req.method === 'OPTIONS') {
      const origin = rphOrigins.has(req.headers.origin) ? req.headers.origin : '*';
      res.writeHead(204, {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    let clientAccess;
    try {
      clientAccess = this.authenticate(req);
    } catch (error) {
      return jsonError(res, error.status || 401, error.message, 'authentication_error');
    }
    if (clientAccess.allowedOrigin === 'codex-router' && !codexRouterAgent.test(req.headers['user-agent'] || '')) {
      return jsonError(res, 403, '公益模型仅限在Codex-Router中使用，您再次尝试不合规请求，账号将遭到封禁，请切换付费分组或转至官方工具使用', 'permission_error');
    }
    if (clientAccess.allowedOrigin && clientAccess.allowedOrigin !== 'codex-router' && !rphOrigins.has(req.headers.origin)) {
      return jsonError(res, 403, '公益模型仅限在RP-Hub官方源站使用，如您再次尝试不合规请求，账号将遭到封禁，请切换付费分组或转至官方源站使用', 'permission_error');
    }
    const originRestricted = clientAccess.allowedOrigin && clientAccess.allowedOrigin !== 'codex-router';
    res.setHeader('access-control-allow-origin', originRestricted ? req.headers.origin : '*');
    if (originRestricted) res.setHeader('vary', 'Origin');
    const clientKeyId = clientAccess.id;

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
    let upstreamBody = forceStreamUsage ? forceUsageBody(raw, request, url.pathname) : raw;
    const supportsLocalCache = ['/v1/chat/completions', '/v1/responses', '/v1/completions'].includes(url.pathname);
    let fingerprintRequest = supportsLocalCache ? cacheRequest(request) : null;
    const excluded = new Set();
    const controller = new AbortController();
    req.once('aborted', () => controller.abort(new Error('客户端已断开')));
    res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('客户端已断开')); });

    let lease;
    let upstream;
    let lastError;
    let bufferedUpstreamBody;
    let finalInternal400 = false;
    let internal400Retries = 0;
    let ordinaryFailures = 0;
    let cacheJob;
    const cacheState = { value: null };
    const cacheFallback = {
      fingerprint: { endpoint: url.pathname, entries: [], totalWeight: 0 },
      hit: { matched: false, exact: false, weight: 0, observedTokens: 0 },
    };
    const startCache = () => {
      if (!cacheJob) cacheJob = this.ledger.resolve(url.pathname, fingerprintRequest, model).then(
        (value) => { cacheState.value = value; return value; },
        (error) => { cacheState.value = cacheFallback; console.error('cache lookup failed:', error.message); return cacheFallback; },
      );
      return cacheJob;
    };
    while (ordinaryFailures < this.config.retryCount) {
      try {
        try {
          lease = await this.pool.acquire(model, excluded, controller.signal);
        } catch (error) {
          if (controller.signal.aborted || !excluded.size) throw error;
          excluded.clear();
          lease = await this.pool.acquire(model, excluded, controller.signal);
        }
        excluded.add(lease.id);
        const target = `${lease.baseUrl}${url.pathname.slice(3)}${url.search}`;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.config.responseHeaderTimeoutMs)]);
        const fetchJob = fetch(target, {
          method: 'POST',
          headers: copyRequestHeaders(req, lease.secret),
          body: upstreamBody,
          signal,
          redirect: 'manual',
        });
        if (supportsLocalCache && lease.useProxyCache) startCache();
        upstream = await fetchJob;
        bufferedUpstreamBody = undefined;
        finalInternal400 = false;
        if (lease.baseUrl !== this.store.defaultUpstreamBaseUrl) {
          lastError = null;
          break;
        }
        if (upstream.status === 400) {
          bufferedUpstreamBody = await upstream.text();
          const shouldRetry = internalServerError400(upstream.status, bufferedUpstreamBody);
          if (shouldRetry && internal400Retries < 2) {
            internal400Retries += 1;
            this.pool.report(lease.id, 'degraded', `HTTP 400: ${bufferedUpstreamBody.slice(0, 500)}`);
            lastError = new Error('Ollama Cloud 返回 HTTP 400 Internal Server Error');
            lease.release();
            lease = null;
            upstream = null;
            bufferedUpstreamBody = undefined;
            continue;
          }
          finalInternal400 = shouldRetry;
          lastError = shouldRetry ? new Error('Ollama Cloud 连续三次返回 HTTP 400 Internal Server Error') : null;
          break;
        }
        if (!retryable.has(upstream.status)) {
          lastError = null;
          break;
        }
        const errorText = (await upstream.text()).slice(0, 500);
        const invalid = upstream.status === 401 || upstream.status === 403;
        const cooldown = upstream.status === 429 ? retryAfterMs(upstream) : 3000;
        this.pool.report(lease.id, invalid ? 'invalid' : upstream.status === 429 ? 'cooldown' : 'degraded', `HTTP ${upstream.status}: ${errorText}`, invalid ? 0 : cooldown);
        lastError = new Error(`Ollama Cloud 返回 HTTP ${upstream.status}`);
        lease.release();
        lease = null;
        upstream = null;
        ordinaryFailures += 1;
      } catch (error) {
        lastError = error;
        const external = lease?.baseUrl !== this.store.defaultUpstreamBaseUrl;
        if (lease) {
          if (!external) this.pool.report(lease.id, 'degraded', error.message, 3000);
          lease.release();
          lease = null;
        }
        if (controller.signal.aborted) break;
        ordinaryFailures = external ? this.config.retryCount : ordinaryFailures + 1;
      }
    }

    if (!upstream || !lease) {
      this.usage.record({ clientKeyId, model, endpoint: url.pathname, status: 502, latencyMs: Date.now() - started, stream, error: lastError?.message });
      return jsonError(res, 502, lastError?.message || '上游 API 暂时不可用');
    }

    const cacheable = supportsLocalCache && lease.useProxyCache;
    if (cacheable) startCache();
    raw = null;
    upstreamBody = null;
    request = null;
    fingerprintRequest = null;
    const external = lease.baseUrl !== this.store.defaultUpstreamBaseUrl;
    if (external && upstream.ok) this.pool.report(lease.id, 'healthy');
    else if (!external && finalInternal400) this.pool.report(lease.id, 'degraded', lastError.message, 3000);
    else if (!external && (upstream.status === 401 || upstream.status === 403)) this.pool.report(lease.id, 'invalid', `HTTP ${upstream.status}`);
    else if (!external && upstream.status < 500) this.pool.report(lease.id, 'healthy');
    if (upstream.ok) lastError = null;

    let usage = null;
    let completed = false;
    try {
      if (stream && upstream.ok && upstream.body) {
        copyResponseHeaders(upstream, res, cacheState.value?.hit, cacheable);
        res.statusCode = upstream.status;
        res.flushHeaders();
        const streamed = await this.pipeStream(
          upstream, res, cacheable ? startCache : async () => cacheFallback, clientWantsUsage, cacheable, controller.signal,
          (progress) => {
            usage = mergeUsage(usage, progress.usage);
            completed ||= progress.complete;
          },
          clientAccess.outputTps,
          lease.replaceUpstreamCache,
        );
        usage = mergeUsage(usage, streamed.usage);
        completed ||= streamed.complete;
        if (!completed) lastError = new Error('上游流式响应未正常结束');
        res.end();
      } else {
        const input = bufferedUpstreamBody ?? await upstream.text();
        const cache = cacheable && upstream.ok ? await startCache() : cacheFallback;
        copyResponseHeaders(upstream, res, cache.hit, cacheable);
        const patched = upstream.ok ? injectUsage(input, cache.hit, cache.fingerprint.totalWeight, cacheable, lease.replaceUpstreamCache) : { data: input, usage: null };
        usage = patched.usage;
        lease.release();
        if (upstream.ok && clientAccess.outputTps && usage?.completionTokens) {
          await wait(usage.completionTokens * 1000 / clientAccess.outputTps, controller.signal);
        }
        completed = true;
        const body = Buffer.from(patched.data);
        res.statusCode = upstream.status;
        res.setHeader('content-length', body.length);
        res.end(body);
      }
    } catch (error) {
      if (!completed) lastError = error;
      if (!res.writableEnded && !res.destroyed) res.destroy(error);
    } finally {
      lease.release();
      if (cacheable && completed && upstream.ok) startCache().then(({ fingerprint }) => {
        this.ledger.register(fingerprint, model, usage?.promptTokens || 0);
      });
      this.usage.record({
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

  async pipeStream(upstream, res, resolveCache, forwardUsage, injectCache, signal, onProgress, outputTps = 0, replaceUpstreamCache = false) {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const limited = Number(outputTps) > 0;
    const pacer = limited ? new TokenPacer(Number(outputTps), signal) : null;
    const send = limited
      ? async (patched) => {
          await pacer.pace(patched.outputCharacters);
          if (patched.event) await writeChunk(res, patched.event, signal);
        }
      : async (patched) => {
          if (patched.event) await writeChunk(res, patched.event, signal);
        };
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
        const relevant = limited || /"(?:reasoning|thinking|usage)"\s*:|\[DONE\]/.test(event);
        const patched = relevant
          ? await patchSseEvent(event, resolveCache, forwardUsage, injectCache, limited, replaceUpstreamCache)
          : { event, usage: null, usageOnly: false, done: false, outputCharacters: 0 };
        usage = mergeUsage(usage, patched.usage);
        if (patched.done || patched.usageOnly) complete = true;
        if (patched.usage || patched.done) onProgress?.({ usage, complete });
        await send(patched);
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      const relevant = limited || /"(?:reasoning|thinking|usage)"\s*:|\[DONE\]/.test(buffer);
      const patched = relevant
        ? await patchSseEvent(buffer, resolveCache, forwardUsage, injectCache, limited, replaceUpstreamCache)
        : { event: buffer, usage: null, usageOnly: false, done: false, outputCharacters: 0 };
      usage = mergeUsage(usage, patched.usage);
      if (patched.done || patched.usageOnly) complete = true;
      if (patched.usage || patched.done) onProgress?.({ usage, complete });
      await send(patched);
    }
    return { usage, complete };
  }
}
