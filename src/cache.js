import { Worker } from 'node:worker_threads';
import { hmac256 } from './crypto.js';

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};

const stable = (value) => JSON.stringify(canonicalize(value));

const toolReference = (ids, value) => {
  if (typeof value !== 'string') return value;
  if (!ids.has(value)) ids.set(value, `call_${ids.size + 1}`);
  return ids.get(value);
};

function normalizeToolReferences(value, ids, parent = '') {
  if (Array.isArray(value)) return value.map((item) => normalizeToolReferences(item, ids, parent));
  if (!value || typeof value !== 'object') return value;
  const type = typeof value.type === 'string' ? value.type : '';
  const callItem = parent === 'tool_calls' || /(?:^|_)(?:tool|function|computer|web_search)_(?:call|use)(?:_|$)/.test(type);
  return Object.fromEntries(Object.keys(value).sort().map((name) => {
    const item = value[name];
    const reference = name === 'tool_call_id' || name === 'call_id' || name === 'tool_use_id';
    if (reference || (name === 'id' && callItem)) return [name, toolReference(ids, item)];
    return [name, normalizeToolReferences(item, ids, name)];
  }));
}

export function buildFingerprint(endpoint, request, key) {
  const base = {};
  for (const field of ['instructions', 'tools', 'response_format']) {
    if (request[field] != null) base[field] = request[field];
  }
  if (request.text?.format != null) base.text_format = request.text.format;

  let blocks = [];
  if (Array.isArray(request.messages)) blocks = request.messages;
  else if (Array.isArray(request.input)) blocks = request.input;
  else if (request.input != null) blocks = [request.input];
  else if (request.prompt != null) blocks = [request.prompt];

  let weight = 0;
  let hash = hmac256(key, `${endpoint}\u001f`);
  const entries = [];
  const toolIds = new Map();
  if (Object.keys(base).length) {
    const segment = stable(base);
    weight = Buffer.byteLength(segment);
    hash = hmac256(key, `${hash}\u001e${segment}`);
    entries.push({ hash, weight });
  }
  for (const block of blocks) {
    const segment = stable(normalizeToolReferences(block, toolIds));
    weight += 1 + Buffer.byteLength(segment);
    hash = hmac256(key, `${hash}\u001e${segment}`);
    entries.push({ hash, weight });
  }
  return { endpoint, entries, totalWeight: weight };
}

export function cachedTokenCount(hit, promptTokens, totalWeight) {
  const total = Math.max(0, Number(promptTokens) || 0);
  if (!hit?.matched || !total || !totalWeight) return 0;
  if (hit.exact) return total;
  if (hit.observedTokens > 0) return Math.min(total, hit.observedTokens);
  return Math.min(total, Math.floor(total * hit.weight / totalWeight));
}

export class CacheLedger {
  constructor(store) {
    this.store = store;
    this.sequence = 0;
    this.pending = new Map();
    this.closing = false;
    this.worker = new Worker(new URL('./cache-worker.js', import.meta.url), {
      workerData: { databasePath: store.databasePath, masterKey: store.masterKey, settings: store.cacheSettings },
    });
    this.worker.on('message', ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    });
    this.worker.on('error', (error) => {
      this.fail(error);
    });
    this.worker.on('exit', (code) => {
      if (!this.closing) this.fail(new Error(`缓存工作线程异常退出：${code}`));
      this.worker = null;
    });
  }

  fail(error) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  request(type, data = {}, timeoutMs = 30_000) {
    if (!this.worker) return Promise.reject(new Error('缓存工作线程不可用'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('缓存处理超时'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...data });
    });
  }

  resolve(endpoint, request, model) {
    return this.request('resolve', { endpoint, request, model });
  }

  register(fingerprint, model, promptTokens = 0) {
    try { this.worker?.postMessage({ type: 'register', fingerprint, model, promptTokens }); } catch {}
  }

  flush() {
    return this.request('flush');
  }

  async configure(settings) {
    const invalid = (message) => Object.assign(new Error(message), { status: 400 });
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)
      || Object.keys(settings).some((key) => !['enabled', 'ttlMs'].includes(key))) {
      throw invalid('缓存设置格式不正确');
    }
    if (Object.hasOwn(settings, 'enabled') && typeof settings.enabled !== 'boolean') throw invalid('开启状态必须为布尔值');
    if (Object.hasOwn(settings, 'ttlMs') && (!Number.isSafeInteger(settings.ttlMs) || settings.ttlMs < 60_000 || settings.ttlMs > 7 * 24 * 60 * 60_000)) {
      throw invalid('缓存时间须在 1 分钟到 7 天之间');
    }
    this.store.cacheSettings = await this.request('configure', { settings });
    return this.store.cacheSettings;
  }

  stats() {
    return this.request('stats');
  }

  clear() {
    return this.request('clear', {}, 120_000);
  }

  async close() {
    if (!this.worker) return;
    const worker = this.worker;
    this.closing = true;
    await this.request('close').catch(() => {});
    this.worker = null;
    await worker.terminate();
  }
}
