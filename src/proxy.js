import { cachedTokenCount } from './cache.js';

const retryable = new Set([401, 403, 408, 429, 500, 502, 503, 504]);
const hopByHop = new Set(['authorization', 'connection', 'content-length', 'content-encoding', 'cookie', 'host', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const rphOrigins = new Set(['https://sta1n156.github.io', 'https://api.sta1n.site', 'https://cdn.sta1n.cn']);
const codexRouterAgent = /^codex-router\/\S+/i;
const internalServerError400 = (status, body) => status === 400 && /\binternal server error\b/i.test(body);
const unsupportedOllamaResponseItems = new Set([
  'web_search_call', 'custom_tool_call', 'custom_tool_call_output', 'computer_call', 'computer_call_output',
  'code_interpreter_call', 'file_search_call', 'mcp_call', 'mcp_list_tools', 'mcp_approval_request', 'mcp_approval_response',
]);

const responseItemText = (item) => {
  const value = item.action || item.output || item.result || item.arguments || item.input || item.content;
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return ''; }
};

export function normalizeOllamaResponsesBody(body) {
  if (!Array.isArray(body?.input)) return body;
  let changed = false;
  const input = body.input.map((item) => {
    if (!item || typeof item !== 'object' || !unsupportedOllamaResponseItems.has(item.type)) return item;
    changed = true;
    const text = responseItemText(item);
    return {
      type: 'message',
      role: item.role === 'user' ? 'user' : 'assistant',
      content: text ? `[${item.type}] ${text}` : `[${item.type}]`,
    };
  });
  return changed ? { ...body, input } : body;
}

const jsonError = (res, status, message, type = 'proxy_error') => {
  if (res.headersSent) return res.destroy();
  const body = JSON.stringify({ error: { message, type, code: status } });
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
};

const bearer = (header = '') => header.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('请求已取消'));
  if (ms <= 0) return resolve();
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
    add(choice.delta?.refusal);
    add(choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.delta?.thinking);
    add(choice.delta?.function_call?.arguments);
    for (const call of choice.delta?.tool_calls || []) add(call.function?.arguments);
  }
  add(object?.delta);
  add(object?.output_text);
  let count = 0;
  for (const part of parts) for (const _ of part) count += 1;
  return count;
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

const reasoningFields = ['reasoning_content', 'reasoning', 'thinking'];
const deltaTextFields = [...reasoningFields, 'content', 'refusal'];
const responseTextEvents = new Set([
  'response.output_text.delta', 'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta', 'response.refusal.delta',
]);

function* smoothTextChunks(object, characters) {
  const sections = [];
  const choice = object?.choices?.length === 1 ? object.choices[0] : null;
  const delta = choice?.delta;
  const responseText = responseTextEvents.has(object?.type) && typeof object.delta === 'string'
    && (!object.logprobs || (Array.isArray(object.logprobs) && !object.logprobs.length));
  // Tool arguments, multimodal data and token logprobs retain their original chunk boundaries.
  const chatText = choice && !choice.logprobs && !choice.message
    && Object.keys(choice).every((key) => ['index', 'delta', 'text', 'finish_reason', 'logprobs'].includes(key))
    && (!delta || Object.keys(delta).every((key) => key === 'role'
      || (deltaTextFields.includes(key) && (delta[key] == null || typeof delta[key] === 'string'))));
  if (responseText) {
    if (object.delta) sections.push({ text: object.delta });
  } else if (chatText) {
    const aliases = reasoningFields.filter((key) => typeof delta?.[key] === 'string' && delta[key]);
    if (aliases.length && aliases.some((key) => delta[key] !== delta[aliases[0]])) {
      yield { object, characters };
      return;
    }
    if (aliases.length) sections.push({ text: delta[aliases[0]], keys: aliases });
    for (const key of ['content', 'refusal']) {
      if (delta?.[key]) sections.push({ text: delta[key], keys: [key] });
    }
    if (typeof choice.text === 'string' && choice.text) sections.push({ text: choice.text });
  }
  if (!sections.length) {
    yield { object, characters };
    return;
  }
  let first = true;
  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    let offset = 0;
    // Iterating the string keeps surrogate pairs intact without allocating a character array.
    for (const character of section.text) {
      offset += character.length;
      const last = i === sections.length - 1 && offset === section.text.length;
      const chunk = { ...object };
      if (!last && chunk.usage) chunk.usage = null;
      if (responseText) chunk.delta = character;
      else {
        const part = { ...choice };
        if (!last && part.finish_reason != null) part.finish_reason = null;
        if (delta) {
          part.delta = first ? { ...delta } : {};
          for (const key of deltaTextFields) delete part.delta[key];
          if (section.keys) for (const key of section.keys) part.delta[key] = character;
        }
        if (typeof choice.text === 'string') part.text = section.keys ? '' : character;
        chunk.choices = [part];
      }
      yield { object: chunk, characters: 1 };
      first = false;
    }
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
  const cachedTokens = Math.min(promptTokens, injectCache ? cachedTokenCount(hit, promptTokens, totalWeight) : upstreamCached);
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

export function injectUsage(data, hit, totalWeight, injectCache = true) {
  let object;
  try {
    object = JSON.parse(data);
  } catch {
    return { data, usage: null, usageOnly: false, reasoningNormalized: false };
  }
  const reasoningNormalized = normalizeReasoning(object);
  const usage = usageFromObject(object, hit, totalWeight, injectCache);
  const usageOnly = Boolean(usage && Array.isArray(object.choices) && object.choices.length === 0);
  return { data: JSON.stringify(object), usage, usageOnly, reasoningNormalized };
}

async function patchSseEvent(event, resolveCache, forwardUsage, injectCache, countOutput = false) {
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
  const usage = usageFromObject(object, cache.hit, cache.fingerprint.totalWeight, injectCache);
  const usageOnly = Boolean(usage && Array.isArray(object.choices) && object.choices.length === 0);
  const done = object?.type === 'response.completed' || object?.response?.status === 'completed';
  const outputCharacters = countOutput ? outputCharacterCount(object) : 0;
  if (usageOnly && !forwardUsage) return { event: '', usage, usageOnly: true, done, outputCharacters };
  const result = { event, usage, usageOnly, done, outputCharacters };
  if (!countOutput && !reasoningNormalized && !(usage && injectCache)) return result;
  const rebuilt = lines.filter((line) => !line.startsWith('data:'));
  const insertAt = rebuilt.findIndex((line) => line === '');
  const position = insertAt < 0 ? rebuilt.length : insertAt;
  const before = rebuilt.slice(0, position).join('\n');
  const after = rebuilt.slice(position).join('\n') || '\n';
  const render = (value) => `${before ? `${before}\n` : ''}data: ${JSON.stringify(value)}\n${after}`;
  if (reasoningNormalized || (usage && injectCache)) result.event = render(object);
  if (countOutput) Object.assign(result, { object, render });
  return result;
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
  if (signal?.aborted) throw signal.reason || new Error('请求已取消');
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

export class ProxyHandler {
  constructor(config, store, pool, ledger, usage) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.ledger = ledger;
    this.usage = usage;
    this.clientInFlight = new Map();
  }

  authenticate(req) {
    const token = bearer(req.headers.authorization);
    if (token) {
      const access = this.store.getClientAccess(token);
      if (access) return access;
      throw Object.assign(new Error(this.store.errorMessage('invalid_client_key')), { status: 401 });
    }
    if (this.config.allowAnonymous) return { id: null, outputTps: 0, allowedOrigin: '', concurrencyLimit: 0 };
    if (!this.store.clientKeyCount()) throw Object.assign(new Error(this.store.errorMessage('no_client_keys')), { status: 503 });
    throw Object.assign(new Error(this.store.errorMessage('missing_client_key')), { status: 401 });
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
    if (name && !selected) return jsonError(res, 404, this.store.errorMessage('model_not_found', { model: name }), 'invalid_request_error');
    const body = JSON.stringify(selected ? convert(selected) : { object: 'list', data: models.map(convert) });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  acquireClientSlot(access) {
    const limit = Number(access.concurrencyLimit) || 0;
    if (access.id == null) return undefined;
    const current = this.clientInFlight.get(access.id) || 0;
    if (limit && current >= limit) return null;
    this.clientInFlight.set(access.id, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.clientInFlight.get(access.id) || 1) - 1;
      if (remaining) this.clientInFlight.set(access.id, remaining);
      else this.clientInFlight.delete(access.id);
    };
  }

  clientConcurrency(id) {
    return this.clientInFlight.get(Number(id)) || 0;
  }

  clientConcurrencySnapshot() {
    return Object.fromEntries(this.clientInFlight);
  }

  async handle(req, res) {
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
    const allowedSite = rphOrigins.has(req.headers.origin);
    const allowedRouter = codexRouterAgent.test(req.headers['user-agent'] || '');
    if (clientAccess.allowedOrigin && !allowedSite && !allowedRouter) {
      return jsonError(res, 403, this.store.errorMessage('whitelist_denied'), 'permission_error');
    }
    const originRestricted = clientAccess.allowedOrigin && allowedSite;
    res.setHeader('access-control-allow-origin', originRestricted ? req.headers.origin : '*');
    if (originRestricted) res.setHeader('vary', 'Origin');
    const clientKeyId = clientAccess.id;

    if (req.method === 'GET' && url.pathname === '/v1/models') return this.models(res);
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) return this.models(res, decodeURIComponent(url.pathname.slice(11)));
    if (req.method !== 'POST' || !url.pathname.startsWith('/v1/')) return jsonError(res, 404, this.store.errorMessage('endpoint_not_found'), 'invalid_request_error');

    const releaseClientSlot = this.acquireClientSlot(clientAccess);
    if (releaseClientSlot === null) {
      return jsonError(res, 503, this.store.errorMessage('client_overloaded'), 'server_error');
    }
    if (releaseClientSlot) {
      res.once('finish', releaseClientSlot);
      res.once('close', releaseClientSlot);
    }

    let raw;
    let request;
    try {
      raw = await readBody(req, this.config.maxRequestBytes);
      request = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      const message = error.status === 413 ? this.store.errorMessage('request_too_large') : this.store.errorMessage('invalid_json');
      return jsonError(res, error.status || 400, message, 'invalid_request_error');
    }

    const model = typeof request.model === 'string' ? request.model : '';
    if (!model) return jsonError(res, 400, this.store.errorMessage('model_required'), 'invalid_request_error');
    const stream = request.stream === true;
    const clientWantsUsage = includeUsage(request);
    const forceStreamUsage = stream && ['/v1/chat/completions', '/v1/completions'].includes(url.pathname) && !clientWantsUsage;
    let upstreamBody = forceStreamUsage ? forceUsageBody(raw, request, url.pathname) : raw;
    const normalizedResponsesBody = url.pathname === '/v1/responses' ? normalizeOllamaResponsesBody(request) : request;
    const normalizedOllamaBody = normalizedResponsesBody === request ? upstreamBody : Buffer.from(JSON.stringify(normalizedResponsesBody));
    const supportsLocalCache = ['/v1/chat/completions', '/v1/responses', '/v1/completions'].includes(url.pathname);
    const excluded = new Set();
    const controller = new AbortController();
    req.once('aborted', () => controller.abort(new Error('客户端已断开')));
    res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('客户端已断开')); });

    let lease;
    let upstream;
    let lastError;
    let bufferedUpstreamBody;
    let internal400Retries = 0;
    let ordinaryFailures = 0;
    let cacheJob;
    const cacheState = { value: null };
    const cacheFallback = {
      fingerprint: { endpoint: url.pathname, entries: [], totalWeight: 0 },
      hit: { matched: false, exact: false, weight: 0, observedTokens: 0 },
    };
    const startCache = () => {
      if (!cacheJob) cacheJob = this.ledger.resolve(url.pathname, cacheRequest(request), model).then(
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
        const body = lease.baseUrl === this.store.defaultUpstreamBaseUrl ? normalizedOllamaBody : upstreamBody;
        const fetchJob = fetch(target, {
          method: 'POST',
          headers: copyRequestHeaders(req, lease.secret),
          body,
          signal,
          redirect: 'manual',
        });
        if (supportsLocalCache && lease.useProxyCache) startCache();
        upstream = await fetchJob;
        bufferedUpstreamBody = undefined;
        if (lease.baseUrl !== this.store.defaultUpstreamBaseUrl) {
          this.pool.reportFailure(lease.id, upstream);
          lastError = null;
          break;
        }
        if (upstream.status === 400) {
          bufferedUpstreamBody = await upstream.text();
          const shouldRetry = internalServerError400(upstream.status, bufferedUpstreamBody);
          if (shouldRetry && internal400Retries < 2) {
            internal400Retries += 1;
            lastError = new Error('Ollama Cloud 返回 HTTP 400 Internal Server Error');
            lease.release();
            lease = null;
            upstream = null;
            bufferedUpstreamBody = undefined;
            continue;
          }
          lastError = shouldRetry ? new Error('Ollama Cloud 连续三次返回 HTTP 400 Internal Server Error') : null;
          break;
        }
        if (!retryable.has(upstream.status)) {
          lastError = null;
          break;
        }
        const errorText = (await upstream.text()).slice(0, 500);
        this.pool.reportFailure(lease.id, upstream, errorText);
        lastError = new Error(this.store.errorMessage('api_unavailable'));
        lease.release();
        lease = null;
        upstream = null;
        ordinaryFailures += 1;
      } catch (error) {
        lastError = error;
        const external = lease?.baseUrl !== this.store.defaultUpstreamBaseUrl;
        if (lease) {
          lease.release();
          lease = null;
        }
        if (controller.signal.aborted) break;
        ordinaryFailures = external ? this.config.retryCount : ordinaryFailures + 1;
      }
    }

    if (!upstream || !lease) {
      return jsonError(res, 502, lastError?.message || this.store.errorMessage('api_unavailable'));
    }

    const cacheable = supportsLocalCache && lease.useProxyCache;
    if (cacheable) startCache();
    raw = null;
    upstreamBody = null;
    request = null;
    if (upstream.ok) this.pool.report(lease.id, 'healthy');
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
        );
        usage = mergeUsage(usage, streamed.usage);
        completed ||= streamed.complete;
        if (!completed) lastError = new Error('上游流式响应未正常结束');
        res.end();
      } else {
        const input = bufferedUpstreamBody ?? await upstream.text();
        const cache = cacheable && upstream.ok ? await startCache() : cacheFallback;
        copyResponseHeaders(upstream, res, cache.hit, cacheable);
        const patched = upstream.ok ? injectUsage(input, cache.hit, cache.fingerprint.totalWeight, cacheable) : { data: input, usage: null };
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
        clientKeyId,
        promptTokens: usage?.promptTokens || 0,
        completionTokens: usage?.completionTokens || 0,
        cachedTokens: usage?.cachedTokens || 0,
        totalTokens: usage?.totalTokens || 0,
      });
    }
  }

  async pipeStream(upstream, res, resolveCache, forwardUsage, injectCache, signal, onProgress, outputTps = 0) {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const limited = Number(outputTps) > 0;
    const pacer = limited ? new TokenPacer(Number(outputTps), signal) : null;
    let sequence = -1;
    const send = limited
      ? async (patched) => {
          for (const frame of smoothTextChunks(patched.object, patched.outputCharacters)) {
            await pacer.pace(frame.characters);
            if (!patched.event) continue;
            let object = frame.object;
            if (Number.isInteger(object?.sequence_number)) {
              sequence = Math.max(sequence + 1, object.sequence_number);
              if (sequence !== object.sequence_number) object = { ...object, sequence_number: sequence };
            }
            await writeChunk(res, object === patched.object ? patched.event : patched.render(object), signal);
          }
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
          ? await patchSseEvent(event, resolveCache, forwardUsage, injectCache, limited)
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
        ? await patchSseEvent(buffer, resolveCache, forwardUsage, injectCache, limited)
        : { event: buffer, usage: null, usageOnly: false, done: false, outputCharacters: 0 };
      usage = mergeUsage(usage, patched.usage);
      if (patched.done || patched.usageOnly) complete = true;
      if (patched.usage || patched.done) onProgress?.({ usage, complete });
      await send(patched);
    }
    return { usage, complete };
  }
}
