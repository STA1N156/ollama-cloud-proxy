const normalizeModels = (data) => {
  const items = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : null;
  if (!items) throw new Error('模型列表格式不正确');
  const models = items.map((item) => {
    const name = item.id || item.name || item.model;
    return {
      name,
      model: name,
      modified_at: item.modified_at || (item.created ? new Date(Number(item.created) * 1000).toISOString() : ''),
      size: item.size,
      digest: item.digest,
      details: item.details || { owner: item.owned_by || '' },
    };
  }).filter((item) => item.name);
  if (!models.length) throw new Error('模型列表为空');
  return models;
};

export class ModelSync {
  constructor(config, store, pool) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.lastError = '';
    this.running = null;
    this.pending = false;
  }

  sync() {
    this.pending = true;
    if (this.running) return this.running;
    this.running = (async () => {
      let count = 0;
      let error = null;
      do {
        this.pending = false;
        try {
          count = await this.#sync();
          error = null;
        } catch (failure) {
          error = failure;
        }
      } while (this.pending);
      if (error) throw error;
      return count;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  async #sync() {
    const sources = [...new Set(this.pool.snapshot().filter((key) => key.enabled).map((key) => key.base_url))];
    if (!sources.length) throw new Error('还没有可用的上游 API');
    const results = await Promise.allSettled(sources.map((source) => this.#syncSource(source)));
    this.pool.reload();
    const failures = results.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || '未知错误');
    this.lastError = failures.join('；');
    const count = results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value : 0), 0);
    if (failures.length === results.length) throw new Error(this.lastError);
    return count;
  }

  async #syncSource(sourceUrl) {
    const excluded = new Set();
    let lastError;
    for (let attempt = 0; attempt < this.config.retryCount; attempt += 1) {
      let lease;
      try {
        lease = await this.pool.acquire('__models__', excluded, undefined, sourceUrl);
        excluded.add(lease.id);
        const url = sourceUrl === this.store.defaultUpstreamBaseUrl ? this.config.modelSyncUrl : `${sourceUrl}/models`;
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${lease.secret}`, accept: 'application/json' },
          signal: AbortSignal.timeout(this.config.responseHeaderTimeoutMs),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const invalid = response.status === 401 || response.status === 403;
          this.pool.report(lease.id, invalid ? 'invalid' : 'degraded', `HTTP ${response.status}`, invalid ? 0 : 3000);
          throw new Error(`${lease.label} 模型同步失败：HTTP ${response.status}`);
        }
        const models = normalizeModels(await response.json());
        this.store.replaceModels(sourceUrl, models);
        this.pool.report(lease.id, 'healthy');
        return models.length;
      } catch (error) {
        lastError = error;
      } finally {
        lease?.release();
      }
    }
    throw lastError || new Error(`${sourceUrl} 模型同步失败`);
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
