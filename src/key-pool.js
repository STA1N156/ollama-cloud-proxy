const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason || new Error('请求已取消'));
  const done = () => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  };
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason || new Error('请求已取消'));
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

export class KeyPool {
  constructor(store, maxInflight) {
    this.store = store;
    this.maxInflight = maxInflight;
    this.keys = new Map();
    this.positions = new Map();
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
  }

  eligible(key, excluded) {
    return key.enabled && key.status !== 'invalid' && !excluded?.has(key.id) && key.cooldown_until <= Date.now();
  }

  tryAcquire(model, excluded) {
    const keys = [...this.keys.values()].sort((a, b) => a.id - b.id);
    if (!keys.some((key) => this.eligible(key, excluded))) return null;
    const start = this.positions.get(model) || 0;
    for (let offset = 0; offset < keys.length; offset += 1) {
      const index = (start + offset) % keys.length;
      const key = keys[index];
      if (!this.eligible(key, excluded) || key.inFlight >= this.maxInflight) continue;
      key.inFlight += 1;
      this.positions.set(model, (index + 1) % keys.length);
      let released = false;
      return {
        id: key.id,
        label: key.label,
        secret: key.secret,
        release: () => {
          if (released) return;
          released = true;
          key.inFlight = Math.max(0, key.inFlight - 1);
        },
      };
    }
    return undefined;
  }

  async acquire(model, excluded = new Set(), signal) {
    while (true) {
      const lease = this.tryAcquire(model, excluded);
      if (lease) return lease;
      if (lease === null) throw new Error('没有可用的 Ollama Cloud 密钥');
      await sleep(20, signal);
    }
  }

  report(id, status, error = '', cooldownMs = 0) {
    const key = this.keys.get(id);
    if (!key) return;
    key.status = status;
    key.last_error = error;
    key.cooldown_until = cooldownMs ? Date.now() + cooldownMs : 0;
    this.store.updateUpstreamHealth(id, status, error, key.cooldown_until);
  }

  snapshot() {
    return [...this.keys.values()].map(({ secret, secret_hash, ...key }) => ({ ...key }));
  }
}
