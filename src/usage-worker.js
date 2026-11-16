import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const db = new DatabaseSync(workerData.databasePath);
const queue = [];
const healthQueue = new Map();

db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');

const upsertClient = db.prepare(`
  INSERT INTO client_usage_totals(client_key_id, prompt_tokens, completion_tokens, cached_tokens, total_tokens)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(client_key_id) DO UPDATE SET
    prompt_tokens=prompt_tokens+excluded.prompt_tokens,
    completion_tokens=completion_tokens+excluded.completion_tokens,
    cached_tokens=cached_tokens+excluded.cached_tokens,
    total_tokens=total_tokens+excluded.total_tokens
`);
const upsertModel = db.prepare(`
  INSERT INTO client_model_usage(client_key_id, model, requests, prompt_tokens, completion_tokens, cached_tokens, total_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(client_key_id, model) DO UPDATE SET
    requests=requests+excluded.requests,
    prompt_tokens=prompt_tokens+excluded.prompt_tokens,
    completion_tokens=completion_tokens+excluded.completion_tokens,
    cached_tokens=cached_tokens+excluded.cached_tokens,
    total_tokens=total_tokens+excluded.total_tokens
`);
const modelSummary = db.prepare(`
  SELECT u.*, COALESCE(c.label, '已删除密钥 #' || u.client_key_id) label, COALESCE(c.last4, '') last4
  FROM client_model_usage u LEFT JOIN client_keys c ON c.id=u.client_key_id
  ORDER BY u.total_tokens DESC, u.requests DESC, u.client_key_id, u.model
`);
const setRecordedSince = db.prepare("INSERT INTO usage_settings(key, value) VALUES ('model_recorded_since', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
db.prepare("INSERT OR IGNORE INTO usage_settings(key, value) VALUES ('model_recorded_since', ?)").run(String(Date.now()));
const updateHealth = db.prepare('UPDATE upstream_keys SET status=?, last_error=?, cooldown_until=?, updated_at=? WHERE id=?');
const number = (value) => Number(value) || 0;
const add = (map, key, initial, item) => {
  const current = map.get(key) || { ...initial };
  for (const [name, value] of Object.entries(item)) current[name] += value;
  map.set(key, current);
};

function migrateRawEvents() {
  const hasRaw = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_events'").get());
  const rolledUp = db.prepare("SELECT value FROM usage_settings WHERE key='rollup_version'").get()?.value === '1';
  if (hasRaw && !rolledUp) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        DELETE FROM client_usage_totals;
        INSERT INTO client_usage_totals(client_key_id, prompt_tokens, completion_tokens, cached_tokens, total_tokens)
        SELECT client_key_id, SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(total_tokens)
        FROM usage_events WHERE client_key_id IS NOT NULL GROUP BY client_key_id;
      `);
      db.prepare("INSERT INTO usage_settings(key, value) VALUES ('rollup_version', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } else if (!rolledUp) {
    db.prepare("INSERT INTO usage_settings(key, value) VALUES ('rollup_version', '1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  }
  db.exec('DROP INDEX IF EXISTS idx_usage_created; DROP INDEX IF EXISTS idx_usage_key_model; DROP TABLE IF EXISTS usage_events; DROP TABLE IF EXISTS usage_latency_hourly; DROP TABLE IF EXISTS usage_hourly;');
}

function flush() {
  if (!queue.length && !healthQueue.size) return;
  const batch = queue.splice(0, 512);
  const health = [...healthQueue.values()];
  healthQueue.clear();
  const clients = new Map();
  const models = new Map();
  for (const item of batch) {
    const prompt = number(item.promptTokens);
    const completion = number(item.completionTokens);
    const cached = number(item.cachedTokens);
    const total = number(item.totalTokens) || prompt + completion;
    if (item.clientKeyId != null) add(clients, Number(item.clientKeyId), { prompt: 0, completion: 0, cached: 0, total: 0 }, { prompt, completion, cached, total });
    if (item.clientKeyId != null && item.model) {
      add(models, JSON.stringify([Number(item.clientKeyId), item.model]),
        { requests: 0, prompt: 0, completion: 0, cached: 0, total: 0 },
        { requests: 1, prompt, completion, cached, total });
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [id, row] of clients) upsertClient.run(id, row.prompt, row.completion, row.cached, row.total);
    for (const [key, row] of models) {
      const [id, model] = JSON.parse(key);
      upsertModel.run(id, model, row.requests, row.prompt, row.completion, row.cached, row.total);
    }
    for (const item of health) updateHealth.run(item.status, String(item.error || '').slice(0, 500), number(item.cooldownUntil), Date.now(), item.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    queue.unshift(...batch);
    for (const item of health) if (!healthQueue.has(item.id)) healthQueue.set(item.id, item);
    throw error;
  }
}

function clearUsage() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM client_usage_totals; DELETE FROM client_model_usage;');
    setRecordedSince.run(String(Date.now()));
    db.exec('COMMIT');
    queue.length = 0;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

migrateRawEvents();
const timer = setInterval(() => {
  try { flush(); } catch (error) { console.error('usage worker failed:', error.message); }
}, 1000);
timer.unref();

parentPort.on('message', (message) => {
  const respond = (result) => message.id && parentPort.postMessage({ id: message.id, result });
  try {
    if (message.type === 'record') {
      queue.push(message.event);
      if (queue.length >= 256) flush();
    } else if (message.type === 'health') healthQueue.set(message.event.id, message.event);
    else if (message.type === 'flush') { flush(); respond(true); }
    else if (message.type === 'summary') {
      do { flush(); } while (queue.length);
      respond({ clientModelUsage: modelSummary.all(), modelRecordedSince: Number(db.prepare("SELECT value FROM usage_settings WHERE key='model_recorded_since'").get().value) });
    }
    else if (message.type === 'clear') { clearUsage(); respond(true); }
    else if (message.type === 'close') { clearInterval(timer); flush(); db.close(); respond(true); parentPort.close(); }
  } catch (error) {
    if (message.id) parentPort.postMessage({ id: message.id, error: error.message });
    else console.error('usage worker failed:', error.message);
  }
});
