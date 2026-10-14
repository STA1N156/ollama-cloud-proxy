const retryAfterMs = (response) => {
  const raw = response.headers.get('retry-after');
  if (!raw) return 30_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1000, date - Date.now()) : 30_000;
};

export class KeyPool {
  constructor(store, reportHealth) {
    this.store = store;
    this.reportHealth = reportHealth;
    this.keys = new Map();
    this.schedules = new Map();
    this.waiters = new Set();
    this.generation = 0;
    this.reload();
  }

  reload() {
    const fresh = this.store.listUpstreamKeys({ reveal: true });
    const seen = new Set();
    for (const row of fresh) {
      seen.add(row.id);
      const current = this.keys.get(row.id) || { inFlight: 0 };
      Object.assign(current, row);
      this.keys.set(row.id, current);
    }
    for (const id of this.keys.keys()) if (!seen.has(id)) this.keys.delete(id);
    this.sortedKeys = [...this.keys.values()].sort((a, b) => a.id - b.id);
    this.reloadModels();
  }

  reloadModels() {
    this.modelsBySource = new Map();
    for (const row of this.store.listModelRoutes()) {
      if (!this.modelsBySource.has(row.source_url)) this.modelsBySource.set(row.source_url, new Set());
      this.modelsBySource.get(row.source_url).add(row.name);
    }
    this.hasModels = this.modelsBySource.size > 0;
    this.schedules.clear();
    this.wake();
  }

  eligible(key, model, excluded, sourceUrl) {
    if (!key.enabled || key.status === 'invalid' || excluded?.has(key.id) || key.cooldown_until > Date.now()
      || (key.base_url === this.store.defaultUpstreamBaseUrl && key.session_quota_blocked)) return false;
    if (sourceUrl) return key.base_url === sourceUrl;
    return !this.hasModels || this.modelsBySource.get(key.base_url)?.has(model);
  }

  tryAcquire(model, excluded, sourceUrl) {
    const keys = this.sortedKeys;
    const eligible = keys.filter((key) => this.eligible(key, model, excluded, sourceUrl));
    if (!eligible.length) return null;
    const ready = eligible.filter((key) => key.inFlight < this.concurrencyLimit(key));
    const available = this.quotaBalanced(ready);
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
    return this.lease(selected);
  }

  lease(selected) {
    selected.inFlight += 1;
    let released = false;
    return {
      id: selected.id,
      label: selected.label,
      baseUrl: selected.base_url,
      secret: selected.secret,
      useProxyCache: this.usesProxyCache(selected),
      release: () => {
        if (released) return;
        released = true;
        selected.inFlight = Math.max(0, selected.inFlight - 1);
        this.wake(selected);
      },
    };
  }

  concurrencyLimit(key) {
    if (key.base_url !== this.store.defaultUpstreamBaseUrl) return Infinity;
    return key.tier === 'pro' ? 2 : 8;
  }

  usesProxyCache(key) {
    return this.store.cacheSettings.enabled && (key.base_url === this.store.defaultUpstreamBaseUrl || key.use_proxy_cache);
  }

  quotaBalanced(keys) {
    const balanceUsage = (key) => Number(key.quota?.weekly?.usage ?? key.quota?.monthly?.usage);
    const fresh = keys.filter((key) => key.base_url === this.store.defaultUpstreamBaseUrl
      && Number.isFinite(balanceUsage(key))
      && Date.now() - Number(key.quotaFetchedAt) < 10 * 60_000);
    if (fresh.length < 2) return keys;
    const lowest = Math.min(...fresh.map(balanceUsage));
    const balanced = new Set(fresh.filter((key) => balanceUsage(key) <= lowest + 0.01).map((key) => key.id));
    return keys.filter((key) => key.base_url !== this.store.defaultUpstreamBaseUrl || !fresh.includes(key) || balanced.has(key.id));
  }

  async acquire(model, excluded = new Set(), signal, sourceUrl) {
    while (true) {
      const generation = this.generation;
      const lease = this.tryAcquire(model, excluded, sourceUrl);
      if (lease) return lease;
      if (lease === null) {
        const error = new Error(sourceUrl ? '该 API 地址没有可用密钥' : this.store.errorMessage('api_unavailable'));
        if (!sourceUrl) error.status = 500;
        throw error;
      }
      await this.wait(signal, generation, model, excluded, sourceUrl);
    }
  }

  wait(signal, generation, model, excluded, sourceUrl) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('请求已取消'));
    if (generation !== this.generation) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { model, excluded, sourceUrl, done: () => { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(signal.reason || new Error('请求已取消')); };
      const cleanup = () => { this.waiters.delete(waiter); signal?.removeEventListener('abort', abort); };
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  wake(key = null) {
    this.generation += 1;
    if (!key) {
      for (const waiter of [...this.waiters]) waiter.done();
      return;
    }
    if (key.inFlight >= this.concurrencyLimit(key)) return;
    for (const waiter of this.waiters) {
      if (this.eligible(key, waiter.model, waiter.excluded, waiter.sourceUrl)) {
        waiter.done();
        return;
      }
    }
  }

  reportFailure(id, response, detail = '') {
    if (response.status !== 403 && response.status !== 429) return;
    this.report(id, response.status === 403 ? 'invalid' : 'cooldown',
      `HTTP ${response.status}${detail ? `: ${detail}` : ''}`, response.status === 429 ? retryAfterMs(response) : 0);
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
    if (status !== 'healthy') {
      for (const schedule of this.schedules.values()) schedule.delete(id);
    }
    if (changed) {
      this.reportHealth?.({ id, status, error: message, cooldownUntil });
      this.wake();
    }
  }

  updateQuota(id, quota, error = '') {
    const key = this.keys.get(id);
    if (!key) return;
    let routingChanged = false;
    key.quotaCheckedAt = Date.now();
    key.quotaError = error.slice(0, 300);
    if (quota) {
      const sessionUsage = Number(quota.session?.usage);
      const blocked = Number.isFinite(sessionUsage) && sessionUsage >= 0.95;
      if (blocked !== key.session_quota_blocked) {
        key.session_quota_blocked = blocked;
        this.store.setUpstreamSessionQuotaBlocked(id, blocked);
        routingChanged = true;
      }
      key.quota = quota;
      key.quotaFetchedAt = key.quotaCheckedAt;
      key.quotaError = '';
    }
    this.schedules.clear();
    if (routingChanged) this.wake();
  }

  snapshot() {
    return [...this.keys.values()].map(({ secret, secret_hash, ...key }) => ({
      ...key,
      tier: key.tier === 'pro' ? 'pro' : 'max',
      tierConfigurable: key.base_url === this.store.defaultUpstreamBaseUrl,
      concurrencyLimit: key.base_url === this.store.defaultUpstreamBaseUrl ? this.concurrencyLimit(key) : null,
      proxyCacheEnabled: this.usesProxyCache(key),
      proxyCacheConfigurable: key.base_url !== this.store.defaultUpstreamBaseUrl,
    }));
  }
}
