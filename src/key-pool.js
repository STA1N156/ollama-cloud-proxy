export class KeyPool {
  constructor(store, maxInflight, reportHealth) {
    this.store = store;
    this.maxInflight = maxInflight;
    this.reportHealth = reportHealth;
    this.keys = new Map();
    this.schedules = new Map();
    this.waiters = new Set();
    this.generation = 0;
    this.reload();
  }

  reload() {
    const fresh = this.store.listUpstreamKeys({ reveal: true });
    this.modelsBySource = new Map();
    for (const row of this.store.listModelRoutes()) {
      if (!this.modelsBySource.has(row.source_url)) this.modelsBySource.set(row.source_url, new Set());
      this.modelsBySource.get(row.source_url).add(row.name);
    }
    this.hasModels = this.modelsBySource.size > 0;
    const seen = new Set();
    for (const row of fresh) {
      seen.add(row.id);
      const current = this.keys.get(row.id) || { inFlight: 0 };
      Object.assign(current, row);
      this.keys.set(row.id, current);
    }
    for (const id of this.keys.keys()) if (!seen.has(id)) this.keys.delete(id);
    this.sortedKeys = [...this.keys.values()].sort((a, b) => a.id - b.id);
    this.schedules.clear();
    this.wake();
  }

  eligible(key, model, excluded, sourceUrl) {
    if (!key.enabled || key.status === 'invalid' || excluded?.has(key.id) || key.cooldown_until > Date.now()) return false;
    if (sourceUrl) return key.base_url === sourceUrl;
    return !this.hasModels || this.modelsBySource.get(key.base_url)?.has(model);
  }

  tryAcquire(model, excluded, sourceUrl) {
    const keys = this.sortedKeys;
    const eligible = keys.filter((key) => this.eligible(key, model, excluded, sourceUrl));
    if (!eligible.length) return null;
    const available = eligible.filter((key) => key.base_url !== this.store.defaultUpstreamBaseUrl || key.inFlight < this.maxInflight);
    if (!available.length) return undefined;

    const scheduleKey = `${sourceUrl || '*'}\0${model}`;
    const schedule = this.schedules.get(scheduleKey) || new Map();
    this.schedules.set(scheduleKey, schedule);
    let selected;
    let best = -Infinity;
    let totalWeight = 0;
    for (const key of available) {
      const weight = key.tier === 'pro' ? 1 : 5;
      const score = (schedule.get(key.id) || 0) + weight;
      schedule.set(key.id, score);
      totalWeight += weight;
      if (score > best) {
        selected = key;
        best = score;
      }
    }
    schedule.set(selected.id, best - totalWeight);
    selected.inFlight += 1;
    let released = false;
    return {
      id: selected.id,
      label: selected.label,
      baseUrl: selected.base_url,
      secret: selected.secret,
      useProxyCache: selected.base_url === this.store.defaultUpstreamBaseUrl || selected.use_proxy_cache,
      replaceUpstreamCache: selected.base_url !== this.store.defaultUpstreamBaseUrl && selected.use_proxy_cache,
      release: () => {
        if (released) return;
        released = true;
        selected.inFlight = Math.max(0, selected.inFlight - 1);
        this.wake();
      },
    };
  }

  async acquire(model, excluded = new Set(), signal, sourceUrl) {
    while (true) {
      const generation = this.generation;
      const lease = this.tryAcquire(model, excluded, sourceUrl);
      if (lease) return lease;
      if (lease === null) throw new Error(sourceUrl ? '该 API 地址没有可用密钥' : `没有支持模型 ${model} 的可用上游密钥`);
      await this.wait(signal, generation);
    }
  }

  wait(signal, generation) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('请求已取消'));
    if (generation !== this.generation) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason || new Error('请求已取消')); };
      const cleanup = () => { this.waiters.delete(done); signal?.removeEventListener('abort', abort); };
      this.waiters.add(done);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  wake() {
    this.generation += 1;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  report(id, status, error = '', cooldownMs = 0) {
    const key = this.keys.get(id);
    if (!key) return;
    const message = error.slice(0, 500);
    const cooldownUntil = cooldownMs ? Date.now() + cooldownMs : 0;
    const changed = key.status !== status || key.last_error !== message || Number(key.cooldown_until) !== cooldownUntil;
    key.status = status;
    key.last_error = message;
    key.cooldown_until = cooldownUntil;
    if (status !== 'healthy') for (const schedule of this.schedules.values()) schedule.delete(id);
    if (changed) this.reportHealth?.({ id, status, error: message, cooldownUntil });
    this.wake();
  }

  snapshot() {
    return [...this.keys.values()].map(({ secret, secret_hash, ...key }) => ({
      ...key,
      tier: key.tier === 'pro' ? 'pro' : 'max',
      tierConfigurable: key.base_url === this.store.defaultUpstreamBaseUrl,
      proxyCacheEnabled: key.base_url === this.store.defaultUpstreamBaseUrl || key.use_proxy_cache,
      proxyCacheConfigurable: key.base_url !== this.store.defaultUpstreamBaseUrl,
    }));
  }
}
