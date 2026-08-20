const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const num = (value) => new Intl.NumberFormat('zh-CN', { notation: Number(value) >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value) || 0);
const tokenM = (value) => `${((Number(value) || 0) / 1_000_000).toFixed(1)} M`;
const exactTokens = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
const seconds = (value) => `${((Number(value) || 0) / 1000).toFixed(1)} s`;
const bytes = (value) => {
  let size = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
};
const time = (value) => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—';
let state = { totals: {}, recent: [], upstreamKeys: [], clientKeys: [], models: [], cache: {} };
let currentPage = 'overview';
const loading = new Map();

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-admin-request': '1', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/admin/api/login') showLogin();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function showLogin() {
  $('#app-view').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
}

function badge(status) {
  const map = {
    healthy: ['健康', 'good'], new: ['待检测', ''], paused: ['已暂停', 'warn'],
    cooldown: ['冷却中', 'warn'], degraded: ['异常', 'bad'], invalid: ['已失效', 'bad'],
  };
  const item = map[status] || [status || '未知', ''];
  return `<span class="badge ${item[1]}">${item[0]}</span>`;
}

function renderOverview() {
  const totals = state.totals;
  const hitRate = Number(totals.prompt_tokens) ? Number(totals.cached_tokens) / Number(totals.prompt_tokens) * 100 : 0;
  const successRate = Number(totals.requests) ? Number(totals.successes) / Number(totals.requests) * 100 : 0;
  $('#metrics').innerHTML = [
    ['REQUESTS', num(totals.requests), `成功率 ${successRate.toFixed(1)}%`],
    ['INPUT TOKENS', tokenM(totals.prompt_tokens), '上游真实输入'],
    ['CACHED TOKENS', tokenM(totals.cached_tokens), `缓存命中率 ${hitRate.toFixed(1)}%`],
    ['OUTPUT TOKENS', tokenM(totals.completion_tokens), '上游真实输出'],
    ['P95 LATENCY', seconds(totals.p95_latency_ms), '95% 请求不超过此耗时'],
  ].map(([label, value, note]) => `<div class="metric"><p class="eyebrow">${label}</p><strong>${value}</strong><span>${note}</span></div>`).join('');

  $('#recent-body').innerHTML = state.recent.length ? state.recent.map((row) => `<tr>
    <td>${time(row.created_at)}</td><td>${esc(row.key_label)}</td><td class="model" title="${esc(row.model)}">${esc(row.model)}</td>
    <td>${exactTokens(row.prompt_tokens)} / ${exactTokens(row.completion_tokens)}</td><td>${exactTokens(row.cached_tokens)}</td>
    <td><span class="badge ${row.status >= 200 && row.status < 300 ? 'good' : 'bad'}">${row.status}</span></td><td>${seconds(row.latency_ms)}</td>
  </tr>`).join('') : '<tr><td class="empty" colspan="7">还没有请求记录</td></tr>';

  $('#password-warning').classList.toggle('hidden', !state.defaultPassword);
  $('#key-warning').classList.toggle('hidden', state.allowAnonymous || state.hasClientKey);
}

function renderKeys() {
  $('#upstream-body').innerHTML = state.upstreamKeys.length ? state.upstreamKeys.map((key) => `<tr>
    <td><strong>${esc(key.label)}</strong></td><td class="api-url" title="${esc(key.base_url)}"><code>${esc(key.base_url)}</code></td><td><code>•••• ${esc(key.last4)}</code></td>
    <td>${key.tierConfigurable ? `<select class="tier-select" data-upstream-tier data-id="${key.id}" aria-label="${esc(key.label)} 等级"><option value="max" ${key.tier === 'max' ? 'selected' : ''}>MAX · 5</option><option value="pro" ${key.tier === 'pro' ? 'selected' : ''}>PRO · 1</option></select>` : '<span class="muted">—</span>'}</td>
    <td>${key.proxyCacheConfigurable ? `<button data-action="toggle-upstream-cache" data-id="${key.id}" data-enabled="${!key.proxyCacheEnabled}">${key.proxyCacheEnabled ? '已开启' : '未开启'}</button>` : '<span class="badge good">固定开启</span>'}</td><td>${badge(key.status)}</td><td>${key.inFlight} / ${key.concurrencyLimit == null ? '不限' : key.concurrencyLimit}${key.enabled ? '' : ' · 暂停'}</td>
    <td><div class="row-actions"><button data-action="test-upstream" data-id="${key.id}">测试</button><button data-action="toggle-upstream" data-id="${key.id}" data-enabled="${!key.enabled}">${key.enabled ? '暂停' : '启用'}</button><button data-action="delete-upstream" data-id="${key.id}">删除</button></div></td>
  </tr>`).join('') : '<tr><td class="empty" colspan="8">请先导入一个上游 API 通道</td></tr>';

  $('#client-body').innerHTML = state.clientKeys.length ? state.clientKeys.map((key) => `<tr>
    <td><strong>${esc(key.label)}</strong></td><td><code>•••• ${esc(key.last4)}</code></td><td title="输入 ${num(key.prompt_tokens)} / 输出 ${num(key.completion_tokens)}">${tokenM(key.total_tokens)}</td>
    <td><div class="rate-control"><input data-client-rate type="number" min="0" max="1000" value="${Number(key.output_tps) || 0}" aria-label="${esc(key.label)} 输出 token 每秒"><span>token/s</span><button data-action="save-client-rate" data-id="${key.id}">保存</button></div></td>
    <td><div class="origin-control"><select data-client-origin aria-label="${esc(key.label)} 白名单"><option value="" ${key.allowed_origin ? '' : 'selected'}>未启用</option><option value="https://sta1n156.github.io" ${key.allowed_origin === 'https://sta1n156.github.io' ? 'selected' : ''}>白名单 1</option><option value="codex-router" ${key.allowed_origin === 'codex-router' ? 'selected' : ''}>白名单 2</option></select><button data-action="save-client-origin" data-id="${key.id}">保存</button></div></td>
    <td><span class="badge ${key.enabled ? 'good' : 'warn'}">${key.enabled ? '启用' : '暂停'}</span></td>
    <td><div class="row-actions"><button data-action="copy-client" data-id="${key.id}" ${key.copyable ? '' : 'disabled title="旧版密钥无法恢复，请重新生成"'}>复制</button><button data-action="toggle-client" data-id="${key.id}" data-enabled="${!key.enabled}">${key.enabled ? '暂停' : '启用'}</button><button data-action="delete-client" data-id="${key.id}">删除</button></div></td>
  </tr>`).join('') : '<tr><td class="empty" colspan="7">尚未生成下游访问密钥</td></tr>';

  $('#key-warning').classList.toggle('hidden', state.allowAnonymous || state.clientKeys.some((key) => key.enabled));
}

function renderCache() {
  $('#cache-entries').textContent = num(state.cache.entries);
  $('#cache-size').textContent = bytes(state.cache.indexedBytes);
  $('#rp-cache-toggle').checked = Boolean(state.cache.rpEnabled);
  $('#rp-cache-status').textContent = state.cache.rpEnabled ? '开启' : '关闭';
  $('#rp-cache-note').textContent = `已储存 ${num(state.cache.rpEntries)} 个分块 · 1 小时过期 · 上限 ${bytes(state.cache.limitBytes)}`;
}

function renderModelMeta() {
  const latest = state.models.reduce((max, model) => Math.max(max, model.synced_at || 0), 0);
  const modelCount = new Set(state.models.map((model) => model.model || model.name)).size;
  const sourceCount = new Set(state.models.map((model) => model.source_url)).size;
  $('#model-meta').textContent = state.modelSyncError ? `部分同步失败：${state.modelSyncError}` : `${modelCount} 个模型记录 · ${sourceCount} 个 API 通道 · ${latest ? `同步于 ${time(latest)}` : '尚未同步'}`;
}

function render(page = currentPage) {
  if (page === 'overview') renderOverview();
  else if (page === 'keys') renderKeys();
  else if (page === 'models') { renderModels(); renderModelMeta(); }
  else if (page === 'usage') renderUsage();
  else if (page === 'cache') renderCache();
}

function renderModels() {
  const groups = new Map();
  for (const model of state.models) {
    if (!groups.has(model.source_url)) groups.set(model.source_url, []);
    groups.get(model.source_url).push(model);
  }
  $('#model-grid').innerHTML = groups.size ? [...groups].map(([source, models]) => `<section class="model-group">
    <div class="model-group-head"><div><strong>${esc(models[0].source_label)}</strong><code title="${esc(source)}">${esc(source)}</code></div><span>${models.length} 个模型 · ${models[0].key_count} 个可用密钥</span></div>
    <div class="model-grid">${models.map((item) => `<div class="model-item"><strong title="${esc(item.name)}">${esc(item.name)}</strong><span>${esc(item.details?.family || item.details?.owner || 'OpenAI 兼容')} · ${item.modified_at ? new Date(item.modified_at).toLocaleDateString('zh-CN') : '自动同步'}</span></div>`).join('')}</div>
  </section>`).join('') : '<div class="empty">还没有同步模型</div>';
}

function renderUsage() {
  const percent = (value) => Math.min(100, Math.max(0, Number(value) * 100));
  const tone = (value) => value >= 90 ? 'bad' : value >= 70 ? 'warn' : '';
  const meter = (label, period) => {
    const used = percent(period?.usage);
    const calls = (period?.models || []).reduce((sum, item) => sum + Number(item.requestCount || 0), 0);
    return `<div class="quota-meter"><div class="quota-meter-label"><span>${label}</span><strong>${used.toFixed(1)}%</strong></div>
      <div class="quota-track"><i class="quota-fill ${tone(used)}" style="width:${used}%"></i></div>
      <div class="quota-meter-note"><span>剩余 ${(100 - used).toFixed(1)}%</span><span>${exactTokens(calls)} 次模型调用</span></div></div>`;
  };
  const modelList = (label, items = []) => `<section class="quota-model-list"><h4>${label}</h4>${items.length ? [...items]
    .sort((a, b) => Number(b.requestCount) - Number(a.requestCount))
    .map((item) => `<div class="quota-model-row"><code title="${esc(item.name)}">${esc(item.name)}</code><strong>${exactTokens(item.requestCount)} 次</strong></div>`).join('') : '<p>暂无模型调用</p>'}</section>`;
  const keys = state.upstreamKeys || [];
  const updated = keys.reduce((latest, key) => Math.max(latest, Number(key.quotaFetchedAt) || 0), 0);
  $('#quota-meta').textContent = `${keys.length} 个 Ollama 密钥 · 周额度较低的账号优先分配${updated ? ` · 更新于 ${time(updated)}` : ''}`;
  $('#quota-grid').innerHTML = keys.length ? keys.map((key) => {
    const quota = key.quota;
    const error = key.quotaError ? `<div class="quota-error">${esc(key.quotaError)}</div>` : '';
    if (!quota) return `<article class="quota-card quota-unavailable"><div class="quota-card-head"><div><strong>${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></div><div>${badge(key.status)}</div></div>
      <div class="quota-wait"><strong>暂未读取到额度</strong><span>${esc(key.quotaError || '正在等待首次同步')}</span></div></article>`;
    return `<article class="quota-card"><div class="quota-card-head"><div><strong>${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></div>
      <div><span class="badge ${key.tier === 'max' ? 'good' : ''}">${String(key.tier || 'max').toUpperCase()}</span>${badge(key.status)}</div></div>
      <div class="quota-meters">${meter('当前 5 小时', quota.session)}${meter('本周额度', quota.weekly)}</div>${error}
      <details class="quota-details"><summary>查看模型调用明细<span>按次数从高到低</span></summary><div class="quota-model-columns">${modelList('当前 5 小时', quota.session?.models)}${modelList('本周', quota.weekly?.models)}</div></details>
      <footer>最近同步 ${time(key.quotaFetchedAt)} · 智能路由已启用</footer></article>`;
  }).join('') : '<div class="empty">还没有添加 Ollama Cloud 密钥</div>';
}

async function load(page = currentPage, force = false) {
  if (loading.has(page)) return loading.get(page);
  const endpoint = {
    overview: `/admin/api/overview?hours=${$('#range').value}`,
    keys: '/admin/api/keys',
    models: '/admin/api/models',
    usage: `/admin/api/usage${force ? '?refresh=1' : ''}`,
    cache: '/admin/api/cache',
  }[page];
  const job = api(endpoint).then((data) => {
    Object.assign(state, data);
    showApp();
    render(page);
  }).catch((error) => {
    if (!$('#app-view').classList.contains('hidden')) toast(error.message);
  }).finally(() => loading.delete(page));
  loading.set(page, job);
  return job;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    await load('overview');
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (!button) return;
  currentPage = button.dataset.page;
  document.querySelectorAll('#nav button').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.page').forEach((page) => page.classList.add('hidden'));
  $(`#page-${currentPage}`).classList.remove('hidden');
  $('#page-title').textContent = { overview: '运行总览', keys: '密钥管理', models: '模型目录', usage: 'Token 用量', cache: '缓存账本' }[currentPage];
  $('#range').classList.toggle('hidden', currentPage === 'usage');
  $('#clear-usage').classList.toggle('hidden', currentPage === 'usage');
  load(currentPage).catch(() => {});
});

$('#upstream-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  try { await api('/admin/api/upstream-keys', { method: 'POST', body: JSON.stringify(body) }); event.target.reset(); toast('上游通道已导入，正在同步模型'); await load('keys'); } catch (error) { toast(error.message); }
});

document.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-upstream-tier]');
  if (!select) return;
  select.disabled = true;
  try {
    await api(`/admin/api/upstream-keys/${select.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ tier: select.value }) });
    toast(select.value === 'max' ? '已设为 MAX，按5倍权重分配' : '已设为 PRO，按1倍权重分配');
    await load('keys');
  } catch (error) {
    toast(error.message);
    await load('keys');
  }
});

$('#client-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  try {
    const result = await api('/admin/api/client-keys', { method: 'POST', body: JSON.stringify(body) });
    event.target.reset();
    $('#new-token').textContent = result.token;
    $('#token-dialog').showModal();
    await load('keys');
  } catch (error) { toast(error.message); }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, enabled } = button.dataset;
  if (action.startsWith('delete') && !confirm('确定删除吗？此操作不能撤销。')) return;
  button.disabled = true;
  try {
    const upstream = action.includes('upstream');
    const base = upstream ? '/admin/api/upstream-keys' : '/admin/api/client-keys';
    if (action === 'toggle-upstream-cache') {
      const useProxyCache = enabled === 'true';
      await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ useProxyCache }) });
      toast(useProxyCache ? '已使用代理缓存并替换上游缓存统计' : '已恢复透传上游缓存统计');
      await load('keys');
      return;
    }
    if (action === 'copy-client') {
      const result = await api(`${base}/${id}/reveal`, { method: 'POST' });
      await navigator.clipboard.writeText(result.token);
      toast('下游密钥已复制');
      return;
    }
    if (action === 'save-client-rate') {
      const input = button.closest('tr').querySelector('[data-client-rate]');
      const rate = Math.min(1000, Math.max(0, Math.floor(Number(input.value) || 0)));
      await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ outputTps: rate }) });
      toast(rate ? `已限制为约 ${rate} token/s` : '已关闭 Token 减速器');
      await load('keys');
      return;
    }
    if (action === 'save-client-origin') {
      const origin = button.closest('tr').querySelector('[data-client-origin]').value;
      await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ allowedOrigin: origin }) });
      toast(origin === 'codex-router' ? '已启用白名单 2，仅接受 codex-router/*' : origin ? '已启用白名单 1，请确认 New API 已透传 Origin' : '已关闭白名单');
      await load('keys');
      return;
    }
    if (action.startsWith('toggle')) await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: enabled === 'true' }) });
    if (action.startsWith('delete')) await api(`${base}/${id}`, { method: 'DELETE' });
    if (action === 'test-upstream') await api(`${base}/${id}/test`, { method: 'POST' });
    toast(action === 'test-upstream' ? '密钥连接正常' : '操作已完成');
    await load('keys');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});

$('#sync-models').addEventListener('click', async () => { try { const result = await api('/admin/api/models/sync', { method: 'POST' }); toast(`已同步 ${result.count} 个模型`); await load('models'); } catch (error) { toast(error.message); } });
$('#clear-usage').addEventListener('click', async (event) => {
  if (!confirm('确定清空全部统计数据吗？密钥和缓存账本不会被删除。')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/admin/api/usage', { method: 'DELETE' });
    if (currentPage === 'overview' || currentPage === 'usage' || currentPage === 'keys') await load(currentPage);
    toast('统计数据已清空');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
$('#rp-cache-toggle').addEventListener('change', async (event) => {
  const input = event.currentTarget;
  input.disabled = true;
  try {
    await api('/admin/api/cache/rp', { method: 'PATCH', body: JSON.stringify({ enabled: input.checked }) });
    toast(input.checked ? 'RP 缓存已开启' : 'RP 缓存已关闭');
    await load('cache');
  } catch (error) {
    toast(error.message);
    await load('cache');
  } finally { input.disabled = false; }
});
$('#clear-cache').addEventListener('click', async () => { if (confirm('确定清空全部缓存前缀和 RP 分块吗？')) { await api('/admin/api/cache', { method: 'DELETE' }); toast('缓存账本已清空'); await load('cache'); } });
$('#refresh').addEventListener('click', () => load(currentPage, true));
$('#range').addEventListener('change', () => { if (currentPage === 'overview') load(currentPage); });
$('#logout').addEventListener('click', async () => { await api('/admin/api/logout', { method: 'POST' }); showLogin(); });
$('#copy-token').addEventListener('click', async () => { await navigator.clipboard.writeText($('#new-token').textContent); toast('已复制'); });
$('#close-dialog').addEventListener('click', () => $('#token-dialog').close());

load('overview');
setInterval(() => {
  if (!$('#app-view').classList.contains('hidden') && (currentPage === 'overview' || currentPage === 'usage')) load(currentPage);
}, 30_000);
