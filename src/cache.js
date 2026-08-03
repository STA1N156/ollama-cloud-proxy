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

export function buildFingerprint(endpoint, request, key) {
  const base = {};
  for (const field of ['instructions', 'tools', 'tool_choice', 'response_format']) {
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
  if (Object.keys(base).length) {
    const segment = stable(base);
    weight = Buffer.byteLength(segment);
    hash = hmac256(key, `${hash}\u001e${segment}`);
    entries.push({ hash, weight });
  }
  for (const block of blocks) {
    const segment = stable(block);
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
  constructor(store, ttlMs) {
    this.sequence = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL('./cache-worker.js', import.meta.url), {
      workerData: { databasePath: store.databasePath, masterKey: store.masterKey, ttlMs },
    });
    this.worker.on('message', ({ id, result, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    });
    this.worker.on('error', (error) => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  request(type, data = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...data });
    });
  }

  resolve(endpoint, request, model) {
    return this.request('resolve', { endpoint, request, model });
  }

  lookup(fingerprint, model) {
    return this.request('lookup', { fingerprint, model });
  }

  register(fingerprint, model, promptTokens = 0) {
    this.worker.postMessage({ type: 'register', fingerprint, model, promptTokens });
  }

  flush() {
    return this.request('flush');
  }

  stats() {
    return this.request('stats');
  }

  clear() {
    return this.request('clear');
  }

  async close() {
    if (!this.worker) return;
    const worker = this.worker;
    await this.request('close').catch(() => {});
    this.worker = null;
    await worker.terminate();
  }
}
