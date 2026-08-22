import { Worker } from 'node:worker_threads';

export class UsageLedger {
  constructor(store) {
    this.sequence = 0;
    this.pending = new Map();
    this.closing = false;
    this.worker = new Worker(new URL('./usage-worker.js', import.meta.url), {
      workerData: { databasePath: store.databasePath },
    });
    this.worker.on('message', ({ id, result, error }) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (error) pending.reject(new Error(error));
      else pending.resolve(result);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => {
      if (!this.closing) this.fail(new Error(`用量工作线程异常退出：${code}`));
      this.worker = null;
    });
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(type, data = {}, timeoutMs = 30_000) {
    if (!this.worker) return Promise.reject(new Error('用量工作线程不可用'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('用量统计处理超时'));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...data });
    });
  }

  record(event) {
    const { upstreamKeyId, clientKeyId, model, promptTokens, completionTokens, cachedTokens, totalTokens, status } = event;
    try {
      this.worker?.postMessage({
        type: 'record',
        event: { createdAt: Date.now(), upstreamKeyId, clientKeyId, model, promptTokens, completionTokens, cachedTokens, totalTokens, status },
      });
    } catch {}
  }

  reportHealth(event) {
    try { this.worker?.postMessage({ type: 'health', event }); } catch {}
  }

  groups(hours) {
    return this.request('groups', { hours });
  }

  flush() {
    return this.request('flush');
  }

  clear() {
    return this.request('clear', {}, 120_000);
  }

  async close() {
    if (!this.worker) return;
    const worker = this.worker;
    this.closing = true;
    await this.request('close', {}, 30_000).catch(() => {});
    this.worker = null;
    await worker.terminate();
  }
}
