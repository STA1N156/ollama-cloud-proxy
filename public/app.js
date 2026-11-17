const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const empty = (text) => `<div class="empty">${text}</div>`;
const grouped = (value) => new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
const tokenM = (value) => `${((Number(value) || 0) / 1_000_000).toFixed(1)} M`;
const time = (value) => value ? new Date(Number(value)).toLocaleString('zh-CN', { hour12: false }) : '—';
const whitelist = 'https://sta1n156.github.io';
const accessOptions = '<option value="">不限制来源</option><option value="' + whitelist + '">白名单</option>'
  + [3, 5, 10, 15, 20, 25, 30, 35, 40, 120].map((limit) => `<option value="limit:${limit}">白名单 + ${limit} 并发</option>`).join('');
for (const field of document.querySelectorAll('select[name="allowedOrigin"]')) field.innerHTML = accessOptions;

const state = { upstreamKeys: [], clientKeys: [], quotaKeys: [], clientModelUsage: [], models: [], errorMessages: [], cache: {} };
const pages = { upstream: '上游通道', client: '下游密钥', models: '模型目录', usage: '额度用量', cache: '缓存', settings: '设置' };
const keyPage = (page) => page === 'upstream' || page === 'client';
const resource = (page) => keyPage(page) ? 'keys' : page;
const loading = new Map();
let currentPage = 'upstream';

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  if (!el.matches(':popover-open')) el.showPopover();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.hidePopover(), 3000);
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
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  setMenu(false);
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

function renderKeys(type) {
  const upstream = type === 'upstream';
  const keys = upstream ? state.upstreamKeys : state.clientKeys;
  const query = $(`#${type}-filter`).value.trim().toLowerCase();
  const matches = keys.filter((key) => !query || [key.label, key.last4, upstream && key.base_url].some((value) => value && String(value).toLowerCase().includes(query)));
  $(`#${type}-count`).textContent = `${query ? `${matches.length} / ` : ''}${keys.length} ${upstream ? '个通道' : '个密钥'}`;
  $(`#${type}-body`).innerHTML = matches.length ? matches.map(upstream ? upstreamRow : clientRow).join('') :
    `<tr><td colspan="6">${empty(query ? '没有匹配的结果' : upstream ? '还没有通道，可以先添加一个上游 API。' : '还没有下游密钥。')}</td></tr>`;
  $('#key-warning').classList.toggle('hidden', state.allowAnonymous || state.clientKeys.some((key) => key.enabled));
  $('#password-warning').classList.toggle('hidden', !state.defaultPassword);
}

function manageButton(type, key) {
  return `<button class="icon-button" type="button" title="设置" aria-label="设置 ${esc(key.label)}" data-action="edit-${type}" data-id="${key.id}">${icon('settings')}</button>`;
}

function upstreamRow(key) {
  const cache = key.proxyCacheEnabled ? '本地缓存' : key.proxyCacheConfigurable ? '上游透传' : '官方缓存';
  return `<tr>
    <td class="identity-cell"><strong title="${esc(key.label)}">${esc(key.label)}</strong><span class="identity-detail"><code title="${esc(key.base_url)}">${esc(key.base_url)}</code><code>•••• ${esc(key.last4)}</code></span></td>
    <td data-label="等级">${key.tierConfigurable ? esc(String(key.tier).toUpperCase()) : '外部 API'}</td>
    <td data-label="缓存">${cache}</td>
    <td data-label="状态">${badge(key.enabled ? key.status : 'paused')}</td>
    <td class="numeric" data-label="并发 / 上限">${key.inFlight} <span class="muted">/ ${key.concurrencyLimit ?? '不限'}</span></td>
    <td class="row-end"><div class="row-actions"><button class="quiet" type="button" data-action="test-upstream" data-id="${key.id}">${icon('play')}<span>测试</span></button>${manageButton('upstream', key)}</div></td>
  </tr>`;
}

const clientLoadLabel = (count, enabled) => `${enabled ? '' : '暂停 · '}${Number(count) || 0}`;

function clientRow(key) {
  const access = key.concurrency_limit ? `白名单 + ${key.concurrency_limit} 并发` : key.allowed_origin ? '白名单' : '不限制来源';
  return `<tr>
    <td class="identity-cell"><strong title="${esc(key.label)}">${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></td>
    <td class="numeric" data-label="总用量" title="输入 ${grouped(key.prompt_tokens)} / 输出 ${grouped(key.completion_tokens)}">${tokenM(key.total_tokens)}</td>
    <td data-label="输出速度">${key.output_tps ? `${Number(key.output_tps)} token/s` : '不限速'}</td>
    <td data-label="访问控制">${access}</td>
    <td data-label="当前并发"><span class="badge ${key.enabled ? 'good' : 'warn'}" data-client-load="${key.id}" data-enabled="${Boolean(key.enabled)}">${clientLoadLabel(key.in_flight, key.enabled)}</span></td>
    <td class="row-end"><div class="row-actions"><button class="quiet" type="button" data-action="copy-client" data-id="${key.id}" ${key.copyable ? '' : 'disabled title="旧版密钥无法恢复，请重新生成"'}>${icon('copy')}<span>复制</span></button>${manageButton('client', key)}</div></td>
  </tr>`;
}

function renderModelMeta() {
  const latest = state.models.reduce((max, model) => Math.max(max, model.synced_at || 0), 0);
  const modelCount = new Set(state.models.map((model) => model.model || model.name)).size;
  const sourceCount = new Set(state.models.map((model) => model.source_url)).size;
  $('#model-meta').textContent = state.modelSyncError ? `部分同步失败：${state.modelSyncError}` : `${modelCount} 个模型 · ${sourceCount} 个 API 通道${latest ? ` · ${time(latest)} 更新` : ''}`;
}

function render(page = currentPage) {
  if (page === 'models') { renderModels(); renderModelMeta(); }
  else if (page === 'usage') renderUsage();
  else if (page === 'cache') renderCache();
  else if (page === 'settings') renderSettings();
}

function renderCache() {
  $('#cache-enabled').checked = Boolean(state.cache.enabled);
  $('#cache-ttl').value = (state.cache.ttlMs ?? 600_000) / 60_000;
  $('#cache-max-hit').value = state.cache.maxHitPercent ?? 99.8;
  $('#cache-status').textContent = state.cache.enabled ? '本地缓存' : '上游透传';
  $('#cache-status').className = `badge ${state.cache.enabled ? 'good' : ''}`;
  $('#cache-entries').textContent = grouped(state.cache.entries);
  $('#cache-size').textContent = `${((Number(state.cache.indexedBytes) || 0) / 1024 / 1024).toFixed(1)} MB`;
}

function renderModels() {
  const container = $('#model-grid');
  const closed = new Set([...container.querySelectorAll('details:not([open])')].map((item) => item.dataset.source));
  const groups = new Map();
  for (const model of state.models) {
    if (!groups.has(model.source_url)) groups.set(model.source_url, []);
    groups.get(model.source_url).push(model);
  }
  container.innerHTML = groups.size ? [...groups].map(([source, models]) => `<details class="model-group" data-source="${esc(source)}" ${closed.has(source) ? '' : 'open'}>
    <summary class="group-head">${icon('chevron')}<span class="identity-cell"><strong>${esc(models[0].source_label)}</strong><code title="${esc(source)}">${esc(source)}</code></span><span class="group-count">${models.length} 个模型 · ${models[0].key_count} 个可用密钥</span></summary>
    <ul class="model-list">${models.map((item) => `<li><span class="model-icon">${icon('model')}</span><span class="model-name"><strong>${esc(item.name)}</strong><span>${esc(item.details?.family || item.details?.owner || 'OpenAI 兼容')}${item.modified_at ? ` · ${new Date(item.modified_at).toLocaleDateString('zh-CN')}` : ''}</span></span><button class="quiet" type="button" data-action="test-model" data-model="${esc(item.name)}" data-source-url="${esc(item.source_url)}">${icon('play')}<span>测试</span></button></li>`).join('')}</ul>
  </details>`).join('') : empty('暂无模型。添加上游通道后可同步。');
}

function renderModelUsage() {
  const container = $('#client-model-usage');
  const opened = new Set([...container.querySelectorAll('details[open]')].map((item) => item.dataset.key));
  const filter = $('#usage-model-filter');
  const selected = filter.value;
  const rows = state.clientModelUsage || [];
  const models = [...new Set(rows.map((row) => row.model))].sort();
  filter.innerHTML = '<option value="">全部模型</option>' + models.map((model) => `<option value="${esc(model)}">${esc(model)}</option>`).join('');
  if (models.includes(selected)) filter.value = selected;
  $('#model-usage-note').textContent = state.modelRecordedSince
    ? `记录始于 ${time(state.modelRecordedSince)}`
    : '从启用记录时起累计';
  const groups = new Map();
  for (const row of rows) {
    if (filter.value && row.model !== filter.value) continue;
    if (!groups.has(row.client_key_id)) groups.set(row.client_key_id, { ...row, calls: 0, tokens: 0, models: [] });
    const group = groups.get(row.client_key_id);
    group.calls += Number(row.requests);
    group.tokens += Number(row.total_tokens);
    group.models.push(row);
  }
  container.innerHTML = groups.size ? [...groups.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls).map((group) => `
    <details class="usage-key" data-key="${group.client_key_id}" ${opened.has(String(group.client_key_id)) ? 'open' : ''}>
      <summary class="group-head">${icon('chevron')}<span class="identity-cell"><strong>${esc(group.label)}</strong><code>•••• ${esc(group.last4)}</code></span><span class="group-count">${grouped(group.calls)} 次 · ${tokenM(group.tokens)} token</span></summary>
      <div class="table-wrap" tabindex="0" aria-label="模型用量"><table><thead><tr><th>模型</th><th>调用次数</th><th>输入</th><th>输出</th><th>缓存</th><th>总 Token</th></tr></thead><tbody>
      ${group.models.map((row) => `<tr><td>${esc(row.model)}</td><td>${grouped(row.requests)}</td>${['prompt_tokens', 'completion_tokens', 'cached_tokens', 'total_tokens'].map((key) => `<td title="${grouped(row[key])}">${tokenM(row[key])}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
    </details>`).join('') : '<div class="empty">暂无该模型的调用记录</div>';
}

function renderUsage() {
  renderModelUsage();
  const percent = (value) => Math.min(100, Math.max(0, Number(value) * 100));
  const tone = (value) => value >= 90 ? 'bad' : value >= 70 ? 'warn' : '';
  const pace = (period) => {
    const start = Date.parse(period?.startsAt);
    const reset = Date.parse(period?.resetsAt);
    const now = Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(reset) || reset <= start) return { text: '周期信息不足，暂无法判断', tone: '' };
    if (now >= reset) return { text: '已到重置时间，等待额度刷新', tone: '' };
    const used = percent(period?.usage);
    if (now <= start) return { text: '周期刚开始，暂无法判断', tone: '' };
    const elapsed = (now - start) / (reset - start) * 100;
    const projected = used / elapsed * 100;
    return {
      text: `期望用量 ${projected.toLocaleString('zh-CN', { maximumFractionDigits: 1, useGrouping: false })}%`,
      tone: projected > 100 ? 'bad' : 'good',
      detail: `周期已过 ${elapsed.toFixed(1)}%，额度已用 ${used.toFixed(1)}%；按本周期平均速度推算，超过 100% 表示可能提前耗尽`,
    };
  };
  const meter = (label, period) => {
    const used = percent(period?.usage);
    const status = pace(period);
    const reset = period?.resetsAt ? new Date(period.resetsAt) : null;
    const remaining = reset ? reset.getTime() - Date.now() : NaN;
    const hours = Math.floor(remaining / 3_600_000);
    const resetText = !Number.isFinite(remaining) ? '重置时间暂不可用'
      : remaining <= 0 ? '等待重置刷新'
        : hours < 1 ? '＜1小时'
          : hours < 24 ? `${hours}小时后` : `${Math.floor(hours / 24)}天${hours % 24}小时后`;
    const resetTitle = Number.isFinite(remaining) ? `重置时间：${reset.toLocaleString('zh-CN', { hour12: false })}` : '';
    return `<div class="quota-meter"><div class="quota-meter-label"><span>${label}</span><strong>${used.toFixed(1)}%</strong></div>
      <progress class="quota-progress ${tone(used)}" max="100" value="${used}" aria-label="${label}已用 ${used.toFixed(1)}%"></progress>
      <div class="quota-meter-note"><span class="quota-pace ${status.tone}" title="${esc(status.detail || '')}">${esc(status.text)}</span><span title="${esc(resetTitle)}">${esc(resetText)}</span></div></div>`;
  };
  const keys = state.quotaKeys || [];
  $('#quota-grid').innerHTML = keys.length ? keys.map((key) => {
    const quota = key.quota;
    const error = key.quotaError ? `<div class="quota-error">${esc(key.quotaError)}</div>` : '';
    if (!quota) return `<article class="quota-card quota-unavailable"><div class="quota-card-head"><div><strong>${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></div><div>${badge(key.status)}</div></div>
      <div class="quota-wait"><strong>暂未读取到额度</strong><span>${esc(key.quotaError || '正在等待首次同步')}</span></div></article>`;
    const periods = [
      quota.session && ['当前 5 小时', quota.session],
      quota.weekly && ['本周额度', quota.weekly],
      quota.monthly && ['本月额度', quota.monthly],
    ].filter(Boolean);
    return `<article class="quota-card"><div class="quota-card-head"><div><strong>${esc(key.label)}</strong><code>•••• ${esc(key.last4)}</code></div>
      <div><span class="badge ${key.tier === 'max' ? 'good' : ''}">${String(key.tier || 'max').toUpperCase()}</span>${badge(key.status)}</div></div>
      <div class="quota-meters">${periods.map((period) => meter(...period)).join('')}</div>${error}</article>`;
  }).join('') : '<div class="empty">还没有添加 Ollama Cloud 密钥</div>';
}

function renderSettings() {
  $('#error-settings-list').innerHTML = state.errorMessages.map((item) => `<label class="error-setting">
    <span><strong>${esc(item.label)}</strong><code class="badge">HTTP ${esc(item.status)}</code></span>
    <textarea name="${esc(item.key)}" maxlength="500" rows="2" required>${esc(item.value)}</textarea>
    ${item.key === 'model_not_found' ? '<small><code>{model}</code> 会替换为实际模型名。</small>' : ''}
  </label>`).join('');
}

async function load(page = currentPage, force = false) {
  const group = resource(page);
  if (loading.has(group)) return loading.get(group);
  const endpoint = {
    keys: '/admin/api/keys',
    models: '/admin/api/models',
    usage: `/admin/api/usage${force ? '?refresh=1' : ''}`,
    cache: '/admin/api/cache',
    settings: '/admin/api/error-messages',
  }[group];
  const sections = group === 'keys' ? [$('#page-upstream'), $('#page-client')] : [$(`#page-${page}`)];
  sections.forEach((section) => section.setAttribute('aria-busy', 'true'));
  if (group === resource(currentPage)) $('#refresh').disabled = true;
  const job = api(endpoint).then((data) => {
    if (group === 'usage') {
      const { upstreamKeys, ...usage } = data;
      Object.assign(state, usage, { quotaKeys: upstreamKeys });
    } else Object.assign(state, data);
    showApp();
    if (group === 'keys') {
      renderKeys('upstream');
      renderKeys('client');
    } else render(page);
  }).catch((error) => {
    if (!$('#app-view').classList.contains('hidden')) toast(error.message);
  }).finally(() => {
    loading.delete(group);
    sections.forEach((section) => section.setAttribute('aria-busy', 'false'));
    $('#refresh').disabled = loading.has(resource(currentPage));
  });
  loading.set(group, job);
  return job;
}

function selectPage(page) {
  currentPage = page;
  document.querySelectorAll('#nav button').forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('.page').forEach((section) => section.classList.toggle('hidden', section.id !== `page-${page}`));
  $('#page-title').textContent = pages[page];
  $('[data-open="upstream-dialog"]').classList.toggle('hidden', page !== 'upstream');
  $('[data-open="client-dialog"]').classList.toggle('hidden', page !== 'client');
  $('#sync-models').classList.toggle('hidden', page !== 'models');
  $('#refresh').disabled = loading.has(resource(page));
  setMenu(false);
  window.scrollTo(0, 0);
  load(page);
  if (page === 'client') refreshClientLoad();
}

function setMenu(open) {
  $('#app-view').classList.toggle('menu-open', open);
  $('#menu-toggle').setAttribute('aria-expanded', String(open));
  $('#menu-toggle').setAttribute('aria-label', open ? '关闭导航' : '打开导航');
}

$('#menu-toggle').addEventListener('click', () => setMenu($('#menu-toggle').getAttribute('aria-expanded') !== 'true'));
$('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-page]');
  if (button) selectPage(button.dataset.page);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#app-view').classList.contains('menu-open')) {
    setMenu(false);
    $('#menu-toggle').focus();
  }
});

const themePref = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const selected = localStorage.getItem('ollama-console-theme');
  const dark = selected ? selected === 'dark' : themePref.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#theme span').textContent = dark ? '浅色模式' : '深色模式';
}
applyTheme();
themePref.addEventListener('change', applyTheme);
$('#theme').addEventListener('click', () => {
  localStorage.setItem('ollama-console-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  applyTheme();
});

for (const type of ['upstream', 'client']) $(`#${type}-filter`).addEventListener('input', () => renderKeys(type));
$('.section-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-usage-view]');
  if (!button) return;
  const view = button.dataset.usageView;
  document.querySelectorAll('[data-usage-view]').forEach((item) => {
    item.classList.toggle('active', item === button);
    item.setAttribute('aria-pressed', String(item === button));
  });
  for (const tab of ['calls', 'quota']) $(`#usage-${tab}`).classList.toggle('hidden', view !== tab);
});

function ask(title, message, buttonLabel) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = message;
  $('#confirm-button').textContent = buttonLabel;
  dialog.returnValue = '';
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}

function bindForm(form, submit) {
  $(form).addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.submitter || event.currentTarget.querySelector('[type="submit"]');
    if (button.disabled) return;
    const target = event.currentTarget;
    button.disabled = true;
    try { await submit(target); }
    catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  });
}

bindForm('#login-form', async () => {
  $('#login-error').textContent = '';
  try {
    await api('/admin/api/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    await load(currentPage);
  } catch (error) { $('#login-error').textContent = error.message; }
});

const keyEndpoint = (type) => `/admin/api/${type === 'upstream' ? 'upstream' : 'client'}-keys`;
for (const type of ['upstream', 'client']) {
  bindForm(`#${type}-form`, async (form) => {
    const result = await api(keyEndpoint(type), { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    form.closest('dialog').close();
    if (type === 'client') {
      $('#new-token').textContent = result.token;
      $('#token-dialog').showModal();
    } else toast('通道已添加，正在同步模型');
    await load(type);
  });
}

const keyDialog = $('#key-dialog');
const keyEditForm = $('#key-edit-form');
function editKey(type, id) {
  const key = (type === 'upstream' ? state.upstreamKeys : state.clientKeys).find((key) => String(key.id) === id);
  if (!key) return;
  keyEditForm.dataset.endpoint = `${keyEndpoint(type)}/${id}`;
  const upstream = type === 'upstream';
  $('#key-dialog-title').textContent = upstream ? '通道设置' : '密钥设置';
  $('#delete-key').textContent = upstream ? '删除通道' : '删除密钥';
  $('#edit-key-name').textContent = key.label;
  $('#edit-key-meta').textContent = [upstream && key.base_url, `•••• ${key.last4}`].filter(Boolean).join('  ·  ');
  const fields = keyEditForm.elements;
  fields.enabled.checked = Boolean(key.enabled);
  const values = {
    tier: upstream && key.tierConfigurable ? key.tier : null,
    useProxyCache: upstream && key.proxyCacheConfigurable ? Boolean(key.use_proxy_cache) : null,
    outputTps: upstream ? null : Number(key.output_tps) || 0,
    allowedOrigin: upstream ? null : key.concurrency_limit ? `limit:${key.concurrency_limit}` : key.allowed_origin ? whitelist : '',
  };
  for (const [name, value] of Object.entries(values)) {
    const field = fields[name];
    field.disabled = value == null;
    field.closest('[data-edit-field]').classList.toggle('hidden', field.disabled);
    if (value == null) continue;
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
  }
  keyDialog.showModal();
}

bindForm('#key-edit-form', async (form) => {
  const body = Object.fromEntries(new FormData(form));
  body.enabled = form.elements.enabled.checked;
  if (!form.elements.useProxyCache.disabled) body.useProxyCache = form.elements.useProxyCache.checked;
  await api(form.dataset.endpoint, { method: 'PATCH', body: JSON.stringify(body) });
  keyDialog.close();
  toast('设置已保存');
  await load(currentPage);
});
$('#delete-key').addEventListener('click', async () => {
  if (!(await ask('确定删除？', `“${$('#edit-key-name').textContent}”将被删除，此操作无法撤销。`, '删除'))) return;
  const button = $('#delete-key');
  button.disabled = true;
  try {
    await api(keyEditForm.dataset.endpoint, { method: 'DELETE' });
    keyDialog.close();
    toast('已删除');
    await load(currentPage);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});

document.addEventListener('click', async (event) => {
  const open = event.target.closest('[data-open]');
  if (open) return document.getElementById(open.dataset.open).showModal();
  const close = event.target.closest('[data-close]');
  if (close) return close.closest('dialog').close();
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id, model, sourceUrl } = button.dataset;
  if (action.startsWith('edit-')) return editKey(action.slice(5), id);
  button.disabled = true;
  const label = button.querySelector('span');
  const previousText = label.textContent;
  if (action.startsWith('test')) label.textContent = '测试中…';
  try {
    if (action === 'test-model') {
      await api('/admin/api/models/test', { method: 'POST', body: JSON.stringify({ model, sourceUrl }) });
      toast(`${model} 回复正常`);
    } else if (action === 'test-upstream') {
      await api(`${keyEndpoint('upstream')}/${id}/test`, { method: 'POST' });
      toast('通道连接正常');
      await load('upstream');
    } else if (action === 'copy-client') {
      const result = await api(`${keyEndpoint('client')}/${id}/reveal`, { method: 'POST' });
      await copyToken(result.token);
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; label.textContent = previousText; }
});

async function copyToken(token) {
  if (!token) return toast('没有可复制的密钥');
  try {
    await navigator.clipboard.writeText(token);
    toast('密钥已复制');
  } catch {
    $('#new-token').textContent = token;
    if (!$('#token-dialog').open) $('#token-dialog').showModal();
    toast('自动复制失败，请选中密钥手动复制');
  }
}
$('#copy-token').addEventListener('click', () => copyToken($('#new-token').textContent));
$('#token-dialog').addEventListener('close', () => { $('#new-token').textContent = ''; });

$('#sync-models').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.querySelector('span').textContent = '同步中…';
  try { const result = await api('/admin/api/models/sync', { method: 'POST' }); toast(`已同步 ${result.count} 个模型`); await load('models'); }
  catch (error) { toast(error.message); }
  finally { button.disabled = false; button.querySelector('span').textContent = '同步模型'; }
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
  const button = event.currentTarget;
  if (!(await ask('恢复默认提示？', '所有自定义错误提示都会被替换。', '恢复默认'))) return;
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
  const button = event.currentTarget;
  if (!(await ask('清空统计？', '将清空累计调用和 Token 统计，密钥和缓存会保留。', '清空统计'))) return;
  button.disabled = true;
  try {
    await api('/admin/api/usage', { method: 'DELETE' });
    await load('usage');
    toast('统计数据已清空');
  } catch (error) { toast(error.message); } finally { button.disabled = false; }
});
$('#cache-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const controls = [...event.currentTarget.querySelectorAll('input, button')];
  controls.forEach((item) => { item.disabled = true; });
  try {
    const result = await api('/admin/api/cache', { method: 'PATCH', body: JSON.stringify({ enabled: $('#cache-enabled').checked, ttlMs: Number($('#cache-ttl').value) * 60_000, maxHitPercent: Number($('#cache-max-hit').value) }) });
    Object.assign(state.cache, result.cache);
    renderCache();
    toast('缓存设置已保存');
  } catch (error) { toast(error.message); }
  finally { controls.forEach((item) => { item.disabled = false; }); }
});
$('#clear-cache').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!(await ask('清空本地缓存？', '只清空本地前缀账本，统计和上游缓存会保留。', '清空缓存'))) return;
  button.disabled = true;
  try {
    await api('/admin/api/cache', { method: 'DELETE' });
    await load('cache');
    toast('本地缓存已清空');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
$('#refresh').addEventListener('click', () => load(currentPage, true));
$('#usage-model-filter').addEventListener('change', renderModelUsage);
$('#logout').addEventListener('click', async () => {
  try { await api('/admin/api/logout', { method: 'POST' }); showLogin(); }
  catch (error) { toast(error.message); }
});

let clientLoadPending = false;
async function refreshClientLoad() {
  if (clientLoadPending || document.hidden || currentPage !== 'client' || $('#app-view').classList.contains('hidden')) return;
  clientLoadPending = true;
  try {
    const { clientInFlight = {} } = await api('/admin/api/client-load');
    document.querySelectorAll('[data-client-load]').forEach((item) => {
      const count = Number(clientInFlight[item.dataset.clientLoad]) || 0;
      item.textContent = clientLoadLabel(count, item.dataset.enabled === 'true');
    });
  } catch { /* 登录状态由 api() 统一处理 */ }
  finally { clientLoadPending = false; }
}

load();
setInterval(refreshClientLoad, 2_000);
setInterval(() => {
  if (!$('#app-view').classList.contains('hidden') && currentPage === 'usage') load(currentPage);
}, 30_000);
