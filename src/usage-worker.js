import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';

const HOUR = 3_600_000;
const RAW_RETENTION_MS = 31 * 24 * HOUR;
const db = new DatabaseSync(workerData.databasePath);
const queue = [];
const healthQueue = new Map();
let lastMaintenance = 0;

db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');

const insertEvent = db.prepare(`
  INSERT INTO usage_events(created_at, upstream_key_id, client_key_id, model, endpoint,
    prompt_tokens, completion_tokens, cached_tokens, total_tokens, status, latency_ms, stream, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
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
const upsertLatency = db.prepare(`
  INSERT INTO usage_latency_hourly(hour, latency_bucket_ms, requests) VALUES (?, ?, ?)
  ON CONFLICT(hour, latency_bucket_ms) DO UPDATE SET requests=requests+excluded.requests
`);
const updateHealth = db.prepare(`
  UPDATE upstream_keys SET status=?, last_error=?, cooldown_until=?, updated_at=? WHERE id=?
`);

const number = (value) => Number(value) || 0;
const hourOf = (stamp) => Math.floor(stamp / HOUR) * HOUR;
const latencyBucket = (value) => Math.ceil(Math.max(0, number(value)) / 100) * 100;
const add = (map, key, initial, item) => {
  const current = map.get(key) || { ...initial };
  for (const [name, value] of Object.entries(item)) current[name] += value;
  map.set(key, current);
};

function backfill() {
  const ready = db.prepare("SELECT value FROM usage_settings WHERE key='rollup_version'").get()?.value === '1';
  if (ready) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      DELETE FROM client_usage_totals;
      DELETE FROM usage_hourly;
      DELETE FROM usage_latency_hourly;
      INSERT INTO client_usage_totals(client_key_id, prompt_tokens, completion_tokens, cached_tokens, total_tokens)
      SELECT client_key_id, SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens), SUM(total_tokens)
      FROM usage_events WHERE client_key_id IS NOT NULL GROUP BY client_key_id;
      INSERT INTO usage_hourly(hour, upstream_key_id, model, requests, successes, prompt_tokens, completion_tokens, cached_tokens)
      SELECT (created_at / ${HOUR}) * ${HOUR}, COALESCE(upstream_key_id, 0), model, COUNT(*),
        SUM(status BETWEEN 200 AND 299), SUM(prompt_tokens), SUM(completion_tokens), SUM(cached_tokens)
      FROM usage_events GROUP BY (created_at / ${HOUR}), COALESCE(upstream_key_id, 0), model;
      INSERT INTO usage_latency_hourly(hour, latency_bucket_ms, requests)
      SELECT (created_at / ${HOUR}) * ${HOUR}, ((latency_ms + 99) / 100) * 100, COUNT(*)
      FROM usage_events GROUP BY (created_at / ${HOUR}), ((latency_ms + 99) / 100);
      INSERT INTO usage_settings(key, value) VALUES ('rollup_version', '1')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function flush() {
  if (!queue.length && !healthQueue.size) return;
  const batch = queue.splice(0, 512);
  const health = [...healthQueue.values()];
  healthQueue.clear();
  const clients = new Map();
  const hours = new Map();
  const latencies = new Map();
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
    const bucket = latencyBucket(item.latencyMs);
    add(latencies, `${hour}\0${bucket}`, { hour, bucket, requests: 0 }, { requests: 1 });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of batch) insertEvent.run(
      item.createdAt, item.upstreamKeyId ?? null, item.clientKeyId ?? null, item.model || '', item.endpoint || '',
      number(item.promptTokens), number(item.completionTokens), number(item.cachedTokens), number(item.totalTokens),
      number(item.status), number(item.latencyMs), item.stream ? 1 : 0, String(item.error || '').slice(0, 500),
    );
    for (const [id, row] of clients) upsertClient.run(id, row.prompt, row.completion, row.cached, row.total);
    for (const row of hours.values()) upsertHourly.run(row.hour, row.upstream, row.model, row.requests, row.successes, row.prompt, row.completion, row.cached);
    for (const row of latencies.values()) upsertLatency.run(row.hour, row.bucket, row.requests);
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
  const cutoff = stamp - RAW_RETENTION_MS;
  db.exec('BEGIN IMMEDIATE');
  try {
    const deleted = db.prepare(`DELETE FROM usage_events WHERE id IN (
      SELECT id FROM usage_events WHERE created_at<? ORDER BY id LIMIT 5000
    )`).run(cutoff);
    db.prepare('DELETE FROM usage_hourly WHERE hour<?').run(hourOf(cutoff));
    db.prepare('DELETE FROM usage_latency_hourly WHERE hour<?').run(hourOf(cutoff));
    db.exec('COMMIT');
    lastMaintenance = Number(deleted.changes) >= 5000 ? 0 : stamp;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function range(hours) {
  const stamp = Date.now();
  const since = stamp - Math.max(1, Number(hours) || 24) * HOUR;
  const currentHour = hourOf(stamp);
  const fullStart = Math.ceil(since / HOUR) * HOUR;
  return { since, currentHour, fullStart };
}

function edgeWhere(bounds, alias = '') {
  const prefix = alias ? `${alias}.` : '';
  if (bounds.fullStart < bounds.currentHour) {
    return { sql: `((${prefix}created_at>=? AND ${prefix}created_at<?) OR ${prefix}created_at>=?)`, args: [bounds.since, bounds.fullStart, bounds.currentHour] };
  }
  return { sql: `${prefix}created_at>=?`, args: [bounds.since] };
}

function mergeTotals(left, right) {
  const result = {};
  for (const key of ['requests', 'successes', 'prompt_tokens', 'completion_tokens', 'cached_tokens']) result[key] = number(left?.[key]) + number(right?.[key]);
  return result;
}

function p95(bounds, requests) {
  if (!requests) return 0;
  const counts = new Map();
  if (bounds.fullStart < bounds.currentHour) {
    for (const row of db.prepare(`SELECT latency_bucket_ms bucket, SUM(requests) requests FROM usage_latency_hourly
      WHERE hour>=? AND hour<? GROUP BY latency_bucket_ms`).all(bounds.fullStart, bounds.currentHour)) {
      counts.set(number(row.bucket), number(row.requests));
    }
  }
  const edge = edgeWhere(bounds);
  for (const row of db.prepare(`SELECT latency_ms bucket, COUNT(*) requests
    FROM usage_events WHERE ${edge.sql} GROUP BY latency_ms`).all(...edge.args)) {
    const bucket = number(row.bucket);
    counts.set(bucket, (counts.get(bucket) || 0) + number(row.requests));
  }
  const target = Math.ceil(requests * 0.95);
  let seen = 0;
  for (const [bucket, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    seen += count;
    if (seen >= target) return bucket;
  }
  return 0;
}

function overview(hours) {
  const bounds = range(hours);
  const hourly = bounds.fullStart < bounds.currentHour
    ? db.prepare(`SELECT COALESCE(SUM(requests),0) requests, COALESCE(SUM(successes),0) successes,
        COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens,
        COALESCE(SUM(cached_tokens),0) cached_tokens FROM usage_hourly WHERE hour>=? AND hour<?`).get(bounds.fullStart, bounds.currentHour)
    : {};
  const edge = edgeWhere(bounds);
  const edges = db.prepare(`SELECT COUNT(*) requests, SUM(status BETWEEN 200 AND 299) successes,
    COALESCE(SUM(prompt_tokens),0) prompt_tokens, COALESCE(SUM(completion_tokens),0) completion_tokens,
    COALESCE(SUM(cached_tokens),0) cached_tokens FROM usage_events WHERE ${edge.sql}`).get(...edge.args);
  const totals = mergeTotals(hourly, edges);
  totals.p95_latency_ms = p95(bounds, totals.requests);
  const recent = db.prepare(`SELECT u.created_at, COALESCE(k.label, '—') key_label, u.model, u.endpoint,
    u.prompt_tokens, u.completion_tokens, u.cached_tokens, u.status, u.latency_ms, u.stream
    FROM usage_events u LEFT JOIN upstream_keys k ON k.id=u.upstream_key_id
    ORDER BY u.id DESC LIMIT 80`).all();
  return { totals, recent };
}

function groups(hours) {
  const bounds = range(hours);
  const merged = new Map();
  const append = (row) => {
    const upstream = number(row.key_id);
    const key = `${upstream}\0${row.model || ''}`;
    add(merged, key, { key_id: upstream || null, model: row.model || '', requests: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }, {
      requests: number(row.requests), prompt_tokens: number(row.prompt_tokens), completion_tokens: number(row.completion_tokens), cached_tokens: number(row.cached_tokens),
    });
  };
  if (bounds.fullStart < bounds.currentHour) {
    for (const row of db.prepare(`SELECT upstream_key_id key_id, model, SUM(requests) requests,
      SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens, SUM(cached_tokens) cached_tokens
      FROM usage_hourly WHERE hour>=? AND hour<? GROUP BY upstream_key_id, model`).all(bounds.fullStart, bounds.currentHour)) append(row);
  }
  const edge = edgeWhere(bounds);
  for (const row of db.prepare(`SELECT COALESCE(upstream_key_id,0) key_id, model, COUNT(*) requests,
    SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens, SUM(cached_tokens) cached_tokens
    FROM usage_events WHERE ${edge.sql} GROUP BY upstream_key_id, model`).all(...edge.args)) append(row);
  const labels = new Map(db.prepare('SELECT id, label FROM upstream_keys').all().map((row) => [number(row.id), row.label]));
  return [...merged.values()].map((row) => ({ ...row, key_label: row.key_id == null ? '未分配' : labels.get(row.key_id) || '未分配' }))
    .sort((a, b) => number(a.key_id) - number(b.key_id) || (b.prompt_tokens + b.completion_tokens) - (a.prompt_tokens + a.completion_tokens));
}

function clearUsage() {
  queue.length = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM usage_events; DELETE FROM client_usage_totals; DELETE FROM usage_hourly; DELETE FROM usage_latency_hourly;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

backfill();
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
    } else if (message.type === 'health') {
      healthQueue.set(message.event.id, message.event);
    } else if (message.type === 'flush') {
      flush(); respond(true);
    } else if (message.type === 'overview') {
      flush(); respond(overview(message.hours));
    } else if (message.type === 'groups') {
      flush(); respond({ byKeyModel: groups(message.hours) });
    } else if (message.type === 'summary') {
      flush(); respond({ ...overview(message.hours), byKeyModel: groups(message.hours) });
    } else if (message.type === 'clear') {
      clearUsage(); respond(true);
    } else if (message.type === 'close') {
      clearInterval(timer); flush(); db.close(); respond(true); parentPort.close();
    }
  } catch (error) {
    if (message.id) parentPort.postMessage({ id: message.id, error: error.message });
    else console.error('usage worker failed:', error.message);
  }
});
