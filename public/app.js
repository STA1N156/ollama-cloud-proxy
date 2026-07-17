const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const num = (value) => new Intl.NumberFormat('zh-CN', { notation: Number(value) >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value) || 0);
const bytes = (value) => {
  let size = Number(value) || 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
};
const time = (value) => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—';
let state = null;

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

function render() {
  const totals = state.totals;
  const hitRate = Number(totals.prompt_tokens) ? Number(totals.cached_tokens) / Number(totals.prompt_tokens) * 100 : 0;
  const successRate = Number(totals.requests) ? Number(totals.successes) / Number(totals.requests) * 100 : 0;
  $('#metrics').innerHTML = [
    ['REQUESTS', num(totals.requests), `成功率 ${successRate.toFixed(1)}%`],
    ['INPUT TOKENS', num(totals.prompt_tokens), '上游真实输入'],
    ['OUTPUT TOKENS', num(totals.completion_tokens), '上游真实输出'],
    ['CACHED TOKENS', num(totals.cached_tokens), `模拟命中率 ${hitRate.toFixed(1)}%`],
    ['AVG LATENCY', `${num(Math.round(totals.avg_latency_ms))} ms`, '包含上游耗时'],
  ].map(([label, value, note]) => `<div class="metric"><p class="eyebrow">${label}</p><strong>${value}</strong><span>${note}</span></div>`).join('');

  $('#recent-body').innerHTML = state.recent.length ? state.recent.map((row) => `<tr>
    <td>${time(row.created_at)}</td><td>${esc(row.key_label)}</td><td class="model" title="${esc(row.model)}">${esc(row.model)}</td>
    <td>${num(row.prompt_tokens)} / ${num(row.completion_tokens)}</td><td>${num(row.cached_tokens)}</td>
    <td><span class="badge ${row.status >= 200 && row.status < 300 ? 'good' : 'bad'}">${row.status}</span></td><td>${num(row.latency_ms)} ms</td>
  </tr>`).join('') : '<tr><td class="empty" colspan="7">还没有请求记录</td></tr>';

  $('#upstream-body').innerHTML = state.upstreamKeys.length ? state.upstreamKeys.map((key) => `<tr>
    <td><strong>${esc(key.label)}</strong></td><td><code>•••• ${esc(key.last4)}</code></td><td>${badge(key.status)}</td><td>${key.inFlight} / ${key.enabled ? '启用' : '暂停'}</td>
    <td><div class="row-actions"><button data-action="test-upstream" data-id="${key.id}">测试</button><button data-action="toggle-upstream" data-id="${key.id}" data-enabled="${!key.enabled}">${key.enabled ? '暂停' : '启用'}</button><button data-action="delete-upstream" data-id="${key.id}">删除</button></div></td>
  </tr>`).join('') : '<tr><td class="empty" colspan="5">请先添加 Ollama Cloud 密钥</td></tr>';

  $('#client-body').innerHTML = state.clientKeys.length ? state.clientKeys.map((key) => `<tr>
    <td><strong>${esc(key.label)}</strong></td><td><code>•••• ${esc(key.last4)}</code></td><td><span class="badge ${key.enabled ? 'good' : 'warn'}">${key.enabled ? '启用' : '暂停'}</span></td>
    <td><div class="row-actions"><button data-action="toggle-client" data-id="${key.id}" data-enabled="${!key.enabled}">${key.enabled ? '暂停' : '启用'}</button><button data-action="delete-client" data-id="${key.id}">删除</button></div></td>
  </tr>`).join('') : '<tr><td class="empty" colspan="4">尚未生成下游访问密钥</td></tr>';

  renderModels();
  $('#usage-body').innerHTML = state.byKeyModel.length ? state.byKeyModel.map((row) => `<tr>
    <td>${esc(row.key_label)}</td><td class="model">${esc(row.model)}</td><td>${num(row.requests)}</td><td>${num(row.prompt_tokens)}</td>
    <td>${num(row.completion_tokens)}</td><td>${num(row.cached_tokens)}</td><td>${num(Math.max(0, Number(row.prompt_tokens) - Number(row.cached_tokens)))}</td>
  </tr>`).join('') : '<tr><td class="empty" colspan="7">还没有可统计的用量</td></tr>';

  $('#cache-entries').textContent = num(state.cache.entries);
  $('#cache-size').textContent = bytes(state.cache.indexedBytes);
  $('#password-warning').classList.toggle('hidden', !state.defaultPassword);
  $('#key-warning').classList.toggle('hidden', state.allowAnonymous || state.clientKeys.some((key) => key.enabled));
  const latest = state.models.reduce((max, model) => Math.max(max, model.synced_at || 0), 0);
  $('#model-meta').textContent = state.modelSyncError ? `最近同步失败：${state.modelSyncError}` : `${state.models.length} 个模型 · ${latest ? `同步于 ${time(latest)}` : '尚未同步'}`;
}

function renderModels() {
  const query = $('#model-filter').value.trim().toLowerCase();
  const models = state.models.filter((item) => item.name.toLowerCase().includes(query));
  $('#model-grid').innerHTML = models.length ? models.map((item) => `<div class="model-item"><strong title="${esc(item.name)}">${esc(item.name)}</strong><span>${esc(item.details?.family || 'Ollama Cloud')} · ${item.modified_at ? new Date(item.modified_at).toLocaleDateString('zh-CN') : '日期未知'}</span></div>`).join('') : '<div class="empty">没有匹配的模型</div>';
}

async function load() {
  try {
    state = await api(`/admin/api/summary?hours=${$('#range').value}`);
    showApp();
    render();
  } catch (error) {
    if (!$('#app-view').classList.contains('hidden')) toast(error.message);
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    await load();
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (!button) return;
  document.querySelectorAll('#nav button').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.page').forEach((page) => page.classList.add('hidden'));
  $(`#page-${button.dataset.page}`).classList.remove('hidden');
  $('#page-title').textContent = { overview: '运行总览', keys: '密钥管理', models: '模型目录', usage: 'Token 用量', cache: '缓存账本' }[button.dataset.page];
});

$('#upstream-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  try { await api('/admin/api/upstream-keys', { method: 'POST', body: JSON.stringify(body) }); event.target.reset(); toast('上游密钥已添加'); await load(); } catch (error) { toast(error.message); }
});

$('#client-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  try {
    const result = await api('/admin/api/client-keys', { method: 'POST', body: JSON.stringify(body) });
    event.target.reset();
    $('#new-token').textContent = result.token;
    $('#token-dialog').showModal();
    await load();
  } catch (error) { toast(error.message); }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, enabled } = button.dataset;
  if (action.startsWith('delete') && !confirm('确定删除吗？此操作不能撤销。')) return;
  button.disabled = true;
  try {
    const upstream = action.endsWith('upstream');
    const base = upstream ? '/admin/api/upstream-keys' : '/admin/api/client-keys';
    if (action.startsWith('toggle')) await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: enabled === 'true' }) });
    if (action.startsWith('delete')) await api(`${base}/${id}`, { method: 'DELETE' });
    if (action === 'test-upstream') await api(`${base}/${id}/test`, { method: 'POST' });
    toast(action === 'test-upstream' ? '密钥连接正常' : '操作已完成');
    await load();
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});

$('#sync-models').addEventListener('click', async () => { try { const result = await api('/admin/api/models/sync', { method: 'POST' }); toast(`已同步 ${result.count} 个模型`); await load(); } catch (error) { toast(error.message); } });
$('#clear-cache').addEventListener('click', async () => { if (confirm('确定清空全部缓存前缀吗？')) { await api('/admin/api/cache', { method: 'DELETE' }); toast('缓存账本已清空'); await load(); } });
$('#model-filter').addEventListener('input', renderModels);
$('#refresh').addEventListener('click', load);
$('#range').addEventListener('change', load);
$('#logout').addEventListener('click', async () => { await api('/admin/api/logout', { method: 'POST' }); showLogin(); });
$('#copy-token').addEventListener('click', async () => { await navigator.clipboard.writeText($('#new-token').textContent); toast('已复制'); });
$('#close-dialog').addEventListener('click', () => $('#token-dialog').close());

load();
setInterval(() => { if (!$('#app-view').classList.contains('hidden')) load(); }, 30_000);
