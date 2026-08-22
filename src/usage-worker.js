import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const HOUR = 3_600_000;
const RETENTION_MS = 31 * 24 * HOUR;
const db = new DatabaseSync(workerData.databasePath);
const queue = [];
const healthQueue = new Map();
let lastMaintenance = 0;

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
const upsertHourly = db.prepare(`
  INSERT INTO usage_hourly(hour, upstream_key_id, model, requests, successes, prompt_tokens, completion_tokens, cached_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(hour, upstream_key_id, model) DO UPDATE SET
    requests=requests+excluded.requests,
    successes=successes+excluded.successes,
    prompt_tokens=prompt_tokens+excluded.prompt_tokens,
    completion_tokens=completion_tokens+excluded.completion_tokens,
    cached_tokens=cached_tokens+excluded.cached_tokens
`);
const updateHealth = db.prepare('UPDATE upstream_keys SET status=?, last_error=?, cooldown_until=?, updated_at=? WHERE id=?');
const number = (value) => Number(value) || 0;
const hourOf = (stamp) => Math.floor(stamp / HOUR) * HOUR;
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
        DELETE FROM usage_hourly;
        INSERT INTO client_usage_totals(client_key_id, prompt_tokens, completion_tokens, cached_tokens, total_tokens)
        SELECT client_key_id, SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(total_tokens)
        FROM usage_events WHERE client_key_id IS NOT NULL GROUP BY client_key_id;
        INSERT INTO usage_hourly(hour, upstream_key_id, model, requests, successes, prompt_tokens, completion_tokens, cached_tokens)
        SELECT (created_at / ${HOUR}) * ${HOUR}, COALESCE(upstream_key_id, 0), model, COUNT(*),
          SUM(status BETWEEN 200 AND 299), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens)
        FROM usage_events GROUP BY (created_at / ${HOUR}), COALESCE(upstream_key_id, 0), model;
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
  db.exec('DROP INDEX IF EXISTS idx_usage_created; DROP INDEX IF EXISTS idx_usage_key_model; DROP TABLE IF EXISTS usage_events; DROP TABLE IF EXISTS usage_latency_hourly;');
}

function flush() {
  if (!queue.length && !healthQueue.size) return;
  const batch = queue.splice(0, 512);
  const health = [...healthQueue.values()];
  healthQueue.clear();
  const clients = new Map();
  const hours = new Map();
  for (const item of batch) {
    const prompt = number(item.promptTokens);
    const completion = number(item.completionTokens);
    const cached = number(item.cachedTokens);
    const total = number(item.totalTokens) || prompt + completion;
    if (item.clientKeyId != null) add(clients, Number(item.clientKeyId), { prompt: 0, completion: 0, cached: 0, total: 0 }, { prompt, completion, cached, total });
    const hour = hourOf(item.createdAt);
    const upstream = Number(item.upstreamKeyId) || 0;
    const key = `${hour}\0${upstream}\0${item.model || ''}`;
    add(hours, key, { hour, upstream, model: item.model || '', requests: 0, successes: 0, prompt: 0, completion: 0, cached: 0 }, {
      requests: 1, successes: item.status >= 200 && item.status < 300 ? 1 : 0, prompt, completion, cached,
    });
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [id, row] of clients) upsertClient.run(id, row.prompt, row.completion, row.cached, row.total);
    for (const row of hours.values()) upsertHourly.run(row.hour, row.upstream, row.model, row.requests, row.successes, row.prompt, row.completion, row.cached);
    for (const item of health) updateHealth.run(item.status, String(item.error || '').slice(0, 500), number(item.cooldownUntil), Date.now(), item.id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    queue.unshift(...batch);
    for (const item of health) if (!healthQueue.has(item.id)) healthQueue.set(item.id, item);
    throw error;
  }
}

function maintain() {
  const stamp = Date.now();
  if (stamp - lastMaintenance < 60_000) return;
  db.prepare('DELETE FROM usage_hourly WHERE hour<?').run(hourOf(stamp - RETENTION_MS));
  lastMaintenance = stamp;
}

function groups(hours) {
  const since = hourOf(Date.now() - Math.max(1, Number(hours) || 24) * HOUR);
  const labels = new Map(db.prepare('SELECT id, label FROM upstream_keys').all().map((row) => [number(row.id), row.label]));
  return db.prepare(`SELECT upstream_key_id key_id, model, SUM(requests) requests,
    SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens, SUM(cached_tokens) cached_tokens
    FROM usage_hourly WHERE hour>=? GROUP BY upstream_key_id, model`).all(since).map((row) => ({
    ...row, key_id: number(row.key_id) || null, key_label: labels.get(number(row.key_id)) || '未分配',
  })).sort((a, b) => number(a.key_id) - number(b.key_id) || (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens));
}

function clearUsage() {
  queue.length = 0;
  db.exec('DELETE FROM client_usage_totals; DELETE FROM usage_hourly;');
}

migrateRawEvents();
maintain();
const timer = setInterval(() => {
  try { flush(); maintain(); } catch (error) { console.error('usage worker failed:', error.message); }
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
    else if (message.type === 'groups') { flush(); respond({ byKeyModel: groups(message.hours) }); }
    else if (message.type === 'clear') { clearUsage(); respond(true); }
    else if (message.type === 'close') { clearInterval(timer); flush(); db.close(); respond(true); parentPort.close(); }
  } catch (error) {
    if (message.id) parentPort.postMessage({ id: message.id, error: error.message });
    else console.error('usage worker failed:', error.message);
  }
});
