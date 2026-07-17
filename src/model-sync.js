export class ModelSync {
  constructor(config, store, pool) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.lastError = '';
    this.running = null;
  }

  sync() {
    if (this.running) return this.running;
    this.running = this.#sync().finally(() => { this.running = null; });
    return this.running;
  }

  async #sync() {
    const excluded = new Set();
    let lastError;
    for (let attempt = 0; attempt < this.config.retryCount; attempt += 1) {
      let lease;
      try {
        lease = await this.pool.acquire('__models__', excluded);
        excluded.add(lease.id);
        const response = await fetch(this.config.modelSyncUrl, {
          headers: { authorization: `Bearer ${lease.secret}`, accept: 'application/json' },
          signal: AbortSignal.timeout(this.config.responseHeaderTimeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const invalid = response.status === 401 || response.status === 403;
          this.pool.report(lease.id, invalid ? 'invalid' : 'degraded', `HTTP ${response.status}`, invalid ? 0 : 3000);
          throw new Error(`模型同步失败：HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!Array.isArray(data.models)) throw new Error('模型列表格式不正确');
        this.store.replaceModels(data.models);
        this.pool.report(lease.id, 'healthy');
        this.lastError = '';
        return data.models.length;
      } catch (error) {
        lastError = error;
      } finally {
        lease?.release();
      }
    }
    this.lastError = lastError?.message || '模型同步失败';
    throw lastError || new Error(this.lastError);
  }

  start() {
    const run = () => this.sync().catch((error) => console.warn(error.message));
    run();
    this.timer = setInterval(run, this.config.modelSyncIntervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
