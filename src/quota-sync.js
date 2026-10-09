const usage = (value) => Math.min(1, Math.max(0, Number(value) || 0));

const period = (used, reset) => ({
  usage: usage(used),
  resetsAt: typeof reset === 'string' && Number.isFinite(Date.parse(reset)) ? new Date(reset).toISOString() : null,
});

const normalize = (data) => {
  const included = data?.included;
  if (included?.session || included?.weekly) {
    const normalized = {};
    for (const name of ['session', 'weekly']) {
      const value = included[name];
      const remaining = value?.remaining_percent;
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > 100) throw new Error('额度接口返回格式不正确');
      normalized[name] = period((100 - remaining) / 100, value.resets_at);
    }
    return normalized;
  }
  if (Number.isFinite(included?.balance_usd) && Number.isFinite(included?.allowance_usd) && included.allowance_usd >= 0) {
    return { monthly: period(included.allowance_usd > 0 ? 1 - included.balance_usd / included.allowance_usd : 1, included.period?.until) };
  }
  throw new Error('额度接口返回格式不正确');
};

export class QuotaSync {
  constructor(config, store, pool) {
    this.config = config;
    this.store = store;
    this.pool = pool;
    this.lastRefresh = 0;
    this.running = null;
  }

  refresh(force = false) {
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastRefresh < this.config.quotaSyncIntervalMs) return Promise.resolve();
    this.running = this.#refresh().finally(() => {
      this.lastRefresh = Date.now();
      this.running = null;
    });
    return this.running;
  }

  async #refresh() {
    const keys = this.store.listUpstreamKeys({ reveal: true })
      .filter((key) => key.base_url === this.store.defaultUpstreamBaseUrl);
    let cursor = 0;
    const worker = async () => {
      while (cursor < keys.length) {
        const key = keys[cursor++];
        await this.#refreshKey(key);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, keys.length) }, worker));
  }

  async #refreshKey(key) {
    try {
      const response = await fetch(this.config.quotaSyncUrl, {
        headers: { authorization: `Bearer ${key.secret}`, accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(this.config.responseHeaderTimeoutMs, 15_000)),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`);
      }
      this.pool.updateQuota(key.id, normalize(await response.json()));
    } catch (error) {
      this.pool.updateQuota(key.id, null, error.message || '额度读取失败');
    }
  }

  start() {
    this.refresh(true).catch((error) => console.warn(`额度同步失败：${error.message}`));
    this.timer = setInterval(() => this.refresh().catch((error) => console.warn(`额度同步失败：${error.message}`)), this.config.quotaSyncIntervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }
}
