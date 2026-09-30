const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const num = (value) => new Intl.NumberFormat('zh-CN', { notation: Number(value) >= 1_000_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value) || 0);
const tokenM = (value) => `${((Number(value) || 0) / 1_000_000).toFixed(1)} M`;
const exactTokens = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
const time = (value) => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—';
let state = { upstreamKeys: [], clientKeys: [], models: [], errorMessages: [], cache: {} };
let currentPage = 'keys';
let currentKeyTab = 'upstream';
const pages = {
  keys: ['密钥管理', 'KEYS', '管理上游连接与客户端访问，独立配置每个密钥。'],
  models: ['模型目录', 'MODELS', '按通道浏览可用模型，发送一条消息检查连接。'],
  usage: ['额度用量', 'USAGE', '查看 Ollama 账号的已用额度与模型调用，展开卡片查看明细。'],
  cache: ['缓存策略', 'CACHE', '选择本地前缀缓存或官方缓存，调整命中有效期。'],
  settings: ['设置', 'SETTINGS', '管理客户端看到的错误提示，随时恢复默认文案。'],
};
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
    cooldown: ['异常', 'bad'], invalid: ['异常', 'bad'],
  };
  const item = map[status] || [status || '未知', ''];
  return `<span class="badge ${item[1]}">${esc(item[0])}</span>`;
}

function renderKeys() {
  $('#upstream-count').textContent = state.upstreamKeys.length;
  $('#client-count').textContent = state.clientKeys.length;
  $('#upstream-body').innerHTML = state.upstreamKeys.length ? state.upstreamKeys.map((key) => `<tr>
    <td class="identity-cell"><strong title="${esc(key.label)}">${esc(key.label)}</strong><code title="${esc(key.base_url)}">${esc(key.base_url)}</code></td><td><code>•••• ${esc(key.last4)}</code></td>
    <td>${key.tierConfigurable ? `<select class="tier-select" data-upstream-tier data-id="${key.id}" aria-label="${esc(key.label)} 等级"><option value="max" ${key.tier === 'max' ? 'selected' : ''}>MAX · 8</option><option value="pro" ${key.tier === 'pro' ? 'selected' : ''}>PRO · 2</option></select>` : '<span class="badge">外部 API</span>'}</td>
    <td>${key.proxyCacheConfigurable ? `<button class="cache-toggle ${key.use_proxy_cache ? 'enabled' : ''}" data-action="toggle-upstream-cache" data-id="${key.id}" data-enabled="${!key.use_proxy_cache}" title="${key.use_proxy_cache && !key.proxyCacheEnabled ? '本地缓存总开关已关闭，当前透传上游缓存' : '本地缓存总开关开启时生效'}">${key.use_proxy_cache ? '本地覆盖' : '上游透传'}</button>` : `<span class="badge ${key.proxyCacheEnabled ? 'good' : ''}">${key.proxyCacheEnabled ? '本地缓存' : '官方缓存'}</span>`}</td><td>${badge(key.status)}</td><td class="load-cell">${key.inFlight} <span>/ ${key.concurrencyLimit == null ? '不限' : key.concurrencyLimit}</span>${key.enabled ? '' : ' · 暂停'}</td>
    <td><div class="row-actions"><button data-action="test-upstream" data-id="${key.id}">测试</button><button data-action="toggle-upstream" data-id="${key.id}" data-enabled="${!key.enabled}">${key.enabled ? '暂停' : '启用'}</button><button class="delete-action" data-action="delete-upstream" data-id="${key.id}">删除</button></div></td>
  </tr>`).join('') : '<tr><td class="empty" colspan="7">暂无上游通道。点击上方“添加上游通道”开始连接。</td></tr>';

  $('#client-body').innerHTML = state.clientKeys.length ? state.clientKeys.map((key) => `<tr>
    <td class="identity-cell"><strong title="${esc(key.label)}">${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></td><td class="token-cell" title="输入 ${num(key.prompt_tokens)} / 输出 ${num(key.completion_tokens)}">${tokenM(key.total_tokens)}</td>
    <td><div class="rate-control" title="流式文字按字符平滑输出，10 约为每 0.1 秒一个字；0 直接透传"><input data-client-rate type="number" min="0" max="1000" value="${Number(key.output_tps) || 0}" aria-label="${esc(key.label)} 输出 token 每秒"><span>token/s</span><button data-action="save-client-rate" data-id="${key.id}">保存</button></div></td>
    <td><div class="origin-control"><select data-client-origin aria-label="${esc(key.label)} 访问控制"><option value="" ${key.allowed_origin ? '' : 'selected'}>未启用</option><option value="https://sta1n156.github.io" ${key.allowed_origin && !key.concurrency_limit ? 'selected' : ''}>白名单</option>${[3, 5, 10, 15, 20, 25, 30, 35, 40].map((limit) => `<option value="limit:${limit}" ${key.concurrency_limit === limit ? 'selected' : ''}>白名单 + ${limit} 并发</option>`).join('')}</select><button data-action="save-client-origin" data-id="${key.id}">保存</button></div></td>
    <td><span class="badge ${key.enabled ? 'good' : 'warn'}" data-client-load="${key.id}" data-enabled="${Boolean(key.enabled)}">${key.enabled ? `${Number(key.in_flight) || 0} 并发` : `暂停 · ${Number(key.in_flight) || 0} 并发`}</span></td>
    <td><div class="row-actions"><button data-action="copy-client" data-id="${key.id}" ${key.copyable ? '' : 'disabled title="旧版密钥无法恢复，请重新生成"'}>复制</button><button data-action="toggle-client" data-id="${key.id}" data-enabled="${!key.enabled}">${key.enabled ? '暂停' : '启用'}</button><button class="delete-action" data-action="delete-client" data-id="${key.id}">删除</button></div></td>
  </tr>`).join('') : '<tr><td class="empty" colspan="6">暂无访问密钥。点击上方“生成访问密钥”供客户端使用。</td></tr>';

  $('#key-warning').classList.toggle('hidden', state.allowAnonymous || state.clientKeys.some((key) => key.enabled));
  $('#password-warning').classList.toggle('hidden', !state.defaultPassword);
}

function renderModelMeta() {
  const latest = state.models.reduce((max, model) => Math.max(max, model.synced_at || 0), 0);
  const modelCount = new Set(state.models.map((model) => model.model || model.name)).size;
  const sourceCount = new Set(state.models.map((model) => model.source_url)).size;
  $('#model-meta').textContent = state.modelSyncError ? `部分同步失败：${state.modelSyncError}` : `${modelCount} 个模型记录 · ${sourceCount} 个 API 通道 · ${latest ? `同步于 ${time(latest)}` : '尚未同步'}`;
}

function render(page = currentPage) {
  if (page === 'keys') renderKeys();
  else if (page === 'models') { renderModels(); renderModelMeta(); }
  else if (page === 'usage') renderUsage();
  else if (page === 'cache') renderCache();
  else if (page === 'settings') renderSettings();
}

function renderCache() {
  $('#cache-enabled').checked = Boolean(state.cache.enabled);
  $('#cache-ttl').value = state.cache.ttlMs / 60_000;
  $('#cache-status').textContent = state.cache.enabled ? '本地缓存已开启' : '使用官方缓存';
  $('#cache-status').className = `badge ${state.cache.enabled ? 'good' : ''}`;
  $('#cache-entries').textContent = exactTokens(state.cache.entries);
  $('#cache-size').textContent = `${((Number(state.cache.indexedBytes) || 0) / 1024 / 1024).toFixed(1)} MB`;
}

function renderModels() {
  const groups = new Map();
  for (const model of state.models) {
    if (!groups.has(model.source_url)) groups.set(model.source_url, []);
    groups.get(model.source_url).push(model);
  }
  $('#model-grid').innerHTML = groups.size ? [...groups].map(([source, models]) => `<section class="model-group">
    <div class="model-group-head"><div><strong>${esc(models[0].source_label)}</strong><code title="${esc(source)}">${esc(source)}</code></div><span>${models.length} 个模型 · ${models[0].key_count} 个可用密钥</span></div>
    <div class="model-grid">${models.map((item) => `<div class="model-item"><div class="model-item-head"><strong title="${esc(item.name)}">${esc(item.name)}</strong><button data-action="test-model" data-model="${esc(item.name)}" data-source-url="${esc(item.source_url)}">测试</button></div><span>${esc(item.details?.family || item.details?.owner || 'OpenAI 兼容')} · ${item.modified_at ? new Date(item.modified_at).toLocaleDateString('zh-CN') : '自动同步'}</span></div>`).join('')}</div>
  </section>`).join('') : '<div class="empty">还没有同步模型</div>';
}

function renderUsage() {
  const percent = (value) => Math.min(100, Math.max(0, Number(value) * 100));
  const tone = (value) => value >= 90 ? 'bad' : value >= 70 ? 'warn' : '';
  const exhaustion = (period, maxMs) => {
    if (percent(period?.usage) >= 100) return '已耗尽';
    const remainingMs = Number(period?.exhaustionMs);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > maxMs) return '暂无法估算';
    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor(totalMinutes % 1440 / 60);
    const minutes = totalMinutes % 60;
    if (days) return `约 ${days}天${hours ? `${hours}小时` : ''}${minutes ? `${minutes}分` : ''}后耗尽`;
    if (hours) return `约 ${hours}小时${minutes ? `${minutes}分` : ''}后耗尽`;
    return `约 ${minutes || 1}分后耗尽`;
  };
  const meter = (label, period, maxMs) => {
    const used = percent(period?.usage);
    const calls = (period?.models || []).reduce((sum, item) => sum + Number(item.requestCount || 0), 0);
    return `<div class="quota-meter"><div class="quota-meter-label"><span>${label}</span><strong>${used.toFixed(1)}%</strong></div>
      <progress class="quota-progress ${tone(used)}" max="100" value="${used}" aria-label="${label}已用 ${used.toFixed(1)}%"></progress>
      <div class="quota-meter-note"><span>${exhaustion(period, maxMs)}</span><span>${exactTokens(calls)} 次模型调用</span></div></div>`;
  };
  const modelList = (label, items = []) => `<section class="quota-model-list"><h4>${label}</h4>${items.length ? [...items]
    .sort((a, b) => Number(b.requestCount) - Number(a.requestCount))
    .map((item) => `<div class="quota-model-row"><code title="${esc(item.name)}">${esc(item.name)}</code><strong>${exactTokens(item.requestCount)} 次</strong></div>`).join('') : '<p>暂无模型调用</p>'}</section>`;
  const keys = state.upstreamKeys || [];
  $('#quota-grid').innerHTML = keys.length ? keys.map((key) => {
    const quota = key.quota;
    const error = key.quotaError ? `<div class="quota-error">${esc(key.quotaError)}</div>` : '';
    if (!quota) return `<article class="quota-card quota-unavailable"><div class="quota-card-head"><div><strong>${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></div><div>${badge(key.status)}</div></div>
      <div class="quota-wait"><strong>暂未读取到额度</strong><span>${esc(key.quotaError || '正在等待首次同步')}</span></div></article>`;
    const periods = [
      quota.session && ['当前 5 小时', quota.session, 5 * 60 * 60_000],
      quota.weekly && ['本周额度', quota.weekly, 7 * 24 * 60 * 60_000],
      quota.monthly && ['本月额度', quota.monthly, 31 * 24 * 60 * 60_000],
    ].filter(Boolean);
    const details = quota.weekly ? ['本周', quota.weekly] : quota.monthly ? ['本月', quota.monthly] : ['当前 5 小时', quota.session];
    return `<article class="quota-card"><div class="quota-card-head"><div><strong>${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></div>
      <div><span class="badge ${key.tier === 'max' ? 'good' : ''}">${String(key.tier || 'max').toUpperCase()}</span>${badge(key.status)}</div></div>
      <div class="quota-meters">${periods.map((period) => meter(...period)).join('')}</div>${error}
      <details class="quota-details"><summary>查看${details[0]}模型调用明细<span>按次数从高到低</span></summary>${modelList(details[0], details[1]?.models)}</details></article>`;
  }).join('') : '<div class="empty">还没有添加 Ollama Cloud 密钥</div>';
}

function renderSettings() {
  $('#error-settings-list').innerHTML = state.errorMessages.map((item) => `<label class="error-setting">
    <span class="error-setting-head"><strong>${esc(item.label)}</strong><code>HTTP ${item.status}</code></span>
    <textarea name="${esc(item.key)}" maxlength="500" rows="3" required>${esc(item.value)}</textarea>
    <small>${item.key === 'model_not_found' ? '可使用 <code>{model}</code> 显示实际模型名' : `系统键：${esc(item.key)}`}</small>
  </label>`).join('');
}

async function load(page = currentPage, force = false) {
  if (loading.has(page)) return loading.get(page);
  const endpoint = {
    keys: '/admin/api/keys',
    models: '/admin/api/models',
    usage: `/admin/api/usage${force ? '?refresh=1' : ''}`,
    cache: '/admin/api/cache',
    settings: '/admin/api/error-messages',
  }[page];
  $(`#page-${page}`).setAttribute('aria-busy', 'true');
  if (page === currentPage) $('#refresh').disabled = true;
  const job = api(endpoint).then((data) => {
    Object.assign(state, data);
    showApp();
    render(page);
  }).catch((error) => {
    if (!$('#app-view').classList.contains('hidden')) toast(error.message);
  }).finally(() => {
    loading.delete(page);
    $(`#page-${page}`).setAttribute('aria-busy', 'false');
    $('#refresh').disabled = loading.has(currentPage);
  });
  loading.set(page, job);
  return job;
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    await load('keys');
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (!button) return;
  currentPage = button.dataset.page;
  document.querySelectorAll('#nav button').forEach((item) => {
    item.classList.toggle('active', item === button);
    if (item === button) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach((page) => page.classList.add('hidden'));
  $(`#page-${currentPage}`).classList.remove('hidden');
  [$('#page-title').textContent, $('#page-category').textContent, $('#page-description').textContent] = pages[currentPage];
  $('#clear-usage').classList.toggle('hidden', !['keys', 'models'].includes(currentPage));
  load(currentPage).catch(() => {});
});

$('.key-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-key-tab]');
  if (!button) return;
  currentKeyTab = button.dataset.keyTab;
  document.querySelectorAll('[data-key-tab]').forEach((item) => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  });
  $('#key-upstream-panel').classList.toggle('hidden', currentKeyTab !== 'upstream');
  $('#key-client-panel').classList.toggle('hidden', currentKeyTab !== 'client');
  if (currentKeyTab === 'client') refreshClientLoad();
});

$('#upstream-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  const button = event.submitter;
  button.disabled = true;
  try {
    await api('/admin/api/upstream-keys', { method: 'POST', body: JSON.stringify(body) });
    event.target.reset();
    event.target.closest('details').open = false;
    toast('上游通道已导入，正在同步模型');
    await load('keys');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

document.addEventListener('change', async (event) => {
  const select = event.target.closest('[data-upstream-tier]');
  if (!select) return;
  select.disabled = true;
  try {
    await api(`/admin/api/upstream-keys/${select.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ tier: select.value }) });
    toast(select.value === 'max' ? 'MAX：最多 8 并发，按5倍权重分配' : 'PRO：最多 2 并发，按1倍权重分配');
    await load('keys');
  } catch (error) {
    toast(error.message);
    await load('keys');
  }
});

$('#client-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.target));
  const button = event.submitter;
  button.disabled = true;
  try {
    const result = await api('/admin/api/client-keys', { method: 'POST', body: JSON.stringify(body) });
    event.target.reset();
    event.target.closest('details').open = false;
    $('#new-token').textContent = result.token;
    $('#token-dialog').showModal();
    await load('keys');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, enabled } = button.dataset;
  if (action.startsWith('delete') && !confirm('确定删除吗？此操作不能撤销。')) return;
  button.disabled = true;
  const label = button.textContent;
  if (action.startsWith('test')) button.textContent = '测试中…';
  try {
    if (action === 'test-model') {
      await api('/admin/api/models/test', { method: 'POST', body: JSON.stringify({ model: button.dataset.model, sourceUrl: button.dataset.sourceUrl }) });
      toast(`${button.dataset.model} 回复正常`);
      return;
    }
    const upstream = action.includes('upstream');
    const base = upstream ? '/admin/api/upstream-keys' : '/admin/api/client-keys';
    if (action === 'toggle-upstream-cache') {
      const useProxyCache = enabled === 'true';
      await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ useProxyCache }) });
      toast(useProxyCache ? '代理缓存已开启，缓存页总开关开启时生效' : '已恢复透传上游缓存统计');
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
      const mode = button.closest('tr').querySelector('[data-client-origin]').value;
      await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ allowedOrigin: mode }) });
      const limit = Number(mode.split(':')[1]) || 0;
      toast(limit ? `已启用白名单并限制为 ${limit} 并发` : mode ? '已启用白名单' : '已关闭白名单');
      await load('keys');
      return;
    }
    if (action.startsWith('toggle')) await api(`${base}/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled: enabled === 'true' }) });
    if (action.startsWith('delete')) await api(`${base}/${id}`, { method: 'DELETE' });
    if (action === 'test-upstream') await api(`${base}/${id}/test`, { method: 'POST' });
    toast(action === 'test-upstream' ? '密钥连接正常' : '操作已完成');
    await load('keys');
  } catch (error) { toast(error.message); } finally { button.disabled = false; button.textContent = label; }
});

$('#sync-models').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = '同步中…';
  try { const result = await api('/admin/api/models/sync', { method: 'POST' }); toast(`已同步 ${result.count} 个模型`); await load('models'); }
  catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = '立即同步'; }
});
$('#error-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const messages = Object.fromEntries(new FormData(event.currentTarget));
    const result = await api('/admin/api/error-messages', { method: 'PATCH', body: JSON.stringify({ messages }) });
    state.errorMessages = result.errorMessages;
    renderSettings();
    toast('错误提示已保存');
  } catch (error) { toast(error.message); }
  finally { if (button) button.disabled = false; }
});
$('#reset-error-messages').addEventListener('click', async (event) => {
  if (!confirm('确定恢复全部默认错误提示吗？')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api('/admin/api/error-messages', { method: 'DELETE' });
    state.errorMessages = result.errorMessages;
    renderSettings();
    toast('已恢复默认错误提示');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#clear-usage').addEventListener('click', async (event) => {
  if (!confirm('确定清空全部统计数据吗？密钥和缓存账本不会被删除。')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/admin/api/usage', { method: 'DELETE' });
    if (currentPage === 'usage' || currentPage === 'keys') await load(currentPage);
    toast('统计数据已清空');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
$('#cache-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const controls = [...event.currentTarget.querySelectorAll('input, button')];
  controls.forEach((item) => { item.disabled = true; });
  try {
    const result = await api('/admin/api/cache', { method: 'PATCH', body: JSON.stringify({ enabled: $('#cache-enabled').checked, ttlMs: Number($('#cache-ttl').value) * 60_000 }) });
    Object.assign(state.cache, result.cache);
    renderCache();
    toast('缓存设置已保存');
  } catch (error) { toast(error.message); }
  finally { controls.forEach((item) => { item.disabled = false; }); }
});
$('#clear-cache').addEventListener('click', async (event) => {
  if (!confirm('确定清空本地缓存账本吗？不会影响密钥、统计和上游官方缓存。')) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/admin/api/cache', { method: 'DELETE' });
    await load('cache');
    toast('本地缓存已清空');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#refresh').addEventListener('click', () => load(currentPage, true));
$('#logout').addEventListener('click', async () => { await api('/admin/api/logout', { method: 'POST' }); showLogin(); });
$('#copy-token').addEventListener('click', async () => { await navigator.clipboard.writeText($('#new-token').textContent); toast('已复制'); });
$('#close-dialog').addEventListener('click', () => $('#token-dialog').close());

let clientLoadPending = false;
async function refreshClientLoad() {
  if (clientLoadPending || document.hidden || currentPage !== 'keys' || currentKeyTab !== 'client' || $('#app-view').classList.contains('hidden')) return;
  clientLoadPending = true;
  try {
    const { clientInFlight = {} } = await api('/admin/api/client-load');
    document.querySelectorAll('[data-client-load]').forEach((item) => {
      const count = Number(clientInFlight[item.dataset.clientLoad]) || 0;
      item.textContent = item.dataset.enabled === 'true' ? `${count} 并发` : `暂停 · ${count} 并发`;
    });
  } catch { /* 登录状态由 api() 统一处理 */ }
  finally { clientLoadPending = false; }
}

load('keys');
setInterval(refreshClientLoad, 2_000);
setInterval(() => {
  if (!$('#app-view').classList.contains('hidden') && currentPage === 'usage') load(currentPage);
}, 30_000);
